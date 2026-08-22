/**
 * Server-side logic for the imposter online mode.
 *
 * Everything that decides or reveals a secret (the word, who the impostor is,
 * the impostor's clue, vote tallies) happens ONLY here, using the Admin SDK,
 * which is the one thing on this whole project allowed to bypass
 * firestore.rules. The client never receives a payload containing a secret it
 * isn't entitled to — see the schema notes at the top of firestore.rules.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const WORDS = require("./words.json");

initializeApp();
const db = getFirestore();

const CUSTOM_KEY = "מותאם אישית";
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud
const MAX_PLAYERS = 20;

function genRoomCode(len = 5) {
  let code = "";
  for (let i = 0; i < len; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return code;
}
function normalizeWord(s) {
  return String(s || "").trim().toLowerCase();
}
function requireAuth(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "יש להתחבר קודם");
  return uid;
}
function buildPool(categories, customWords) {
  const pool = [];
  (categories || []).forEach((cat) => {
    if (cat === CUSTOM_KEY) {
      (customWords || []).forEach(([w, clue]) => { if (w) pool.push([w, clue || "—"]); });
    } else if (WORDS[cat]) {
      WORDS[cat].forEach(([w, clue]) => pool.push([w, clue]));
    }
  });
  return pool;
}

// ============================================================================
// createRoom — host opens a room. No round starts yet; players just join.
// ============================================================================
exports.createRoom = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const hostName = String(data.hostName || "").trim().slice(0, 20);
  const impostorCount = Number(data.impostorCount);
  const totalRounds = Number(data.totalRounds);
  const categories = Array.isArray(data.categories) ? data.categories.filter((c) => typeof c === "string") : [];
  const customWords = Array.isArray(data.customWords)
    ? data.customWords.filter((p) => Array.isArray(p) && p[0]).map(([w, c]) => [String(w).slice(0, 40), String(c || "").slice(0, 40)])
    : [];

  if (!hostName) throw new HttpsError("invalid-argument", "צריך שם שחקן");
  if (!Number.isInteger(impostorCount) || impostorCount < 1 || impostorCount > 10) {
    throw new HttpsError("invalid-argument", "מספר מתחזים לא תקין");
  }
  if (![1, 3, 5, 10].includes(totalRounds)) throw new HttpsError("invalid-argument", "מספר סיבובים לא תקין");
  if (categories.length === 0) throw new HttpsError("invalid-argument", "בחרו לפחות קטגוריה אחת");
  if (buildPool(categories, customWords).length === 0) {
    throw new HttpsError("invalid-argument", "אין מילים בקטגוריות שנבחרו");
  }

  let roomId = null, roomRef = null;
  for (let attempt = 0; attempt < 10 && !roomId; attempt++) {
    const candidate = genRoomCode();
    const ref = db.collection("rooms").doc(candidate);
    if (!(await ref.get()).exists) { roomId = candidate; roomRef = ref; }
  }
  if (!roomId) throw new HttpsError("resource-exhausted", "נסו שוב בעוד רגע");

  const now = FieldValue.serverTimestamp();
  await roomRef.set({
    hostUid: uid, hostName, status: "waiting",
    impostorCount, totalRounds, currentRound: 0,
    categories, customWords,
    createdAt: now, updatedAt: now,
  });
  await roomRef.collection("players").doc(uid).set({
    name: hostName, connected: true, isHost: true, score: 0, joinedAt: now,
  });

  return { roomId };
});

// ============================================================================
// joinRoom — a player enters an existing waiting room.
// ============================================================================
exports.joinRoom = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const roomId = String(data.roomId || "").trim().toUpperCase();
  const name = String(data.name || "").trim().slice(0, 20);
  if (!roomId) throw new HttpsError("invalid-argument", "צריך קוד משחק");
  if (!name) throw new HttpsError("invalid-argument", "צריך שם שחקן");

  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) throw new HttpsError("not-found", "לא נמצא משחק עם הקוד הזה");
    const room = roomSnap.data();

    const playerRef = roomRef.collection("players").doc(uid);
    const playersSnap = await tx.get(roomRef.collection("players"));
    const alreadyIn = playersSnap.docs.find((d) => d.id === uid);

    if (!alreadyIn) {
      if (room.status !== "waiting") throw new HttpsError("failed-precondition", "המשחק כבר התחיל");
      if (playersSnap.size >= MAX_PLAYERS) throw new HttpsError("resource-exhausted", "החדר מלא");
      const nameTaken = playersSnap.docs.some((d) => normalizeWord(d.data().name) === normalizeWord(name));
      if (nameTaken) throw new HttpsError("already-exists", "השם הזה כבר בשימוש במשחק");
      tx.set(playerRef, { name, connected: true, isHost: false, score: 0, joinedAt: FieldValue.serverTimestamp() });
    } else {
      // reconnect — just mark connected again, keep score/name
      tx.update(playerRef, { connected: true });
    }
    tx.update(roomRef, { updatedAt: FieldValue.serverTimestamp() });
  });

  return { roomId };
});

// ============================================================================
// leaveRoom — best-effort explicit leave (page unload isn't 100% reliable
// without Realtime Database's onDisconnect; this covers the common case of
// someone tapping "leave"). Reassigns host if the host leaves.
// ============================================================================
exports.leaveRoom = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = String((request.data || {}).roomId || "").trim().toUpperCase();
  if (!roomId) throw new HttpsError("invalid-argument", "חסר קוד משחק");
  const roomRef = db.collection("rooms").doc(roomId);

  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) return;
    const room = roomSnap.data();
    const playerRef = roomRef.collection("players").doc(uid);
    const playersSnap = await tx.get(roomRef.collection("players").where("connected", "==", true));
    const others = playersSnap.docs.filter((d) => d.id !== uid);

    tx.update(playerRef, { connected: false });

    if (room.hostUid === uid) {
      if (others.length > 0) {
        tx.update(roomRef, { hostUid: others[0].id, hostName: others[0].data().name, updatedAt: FieldValue.serverTimestamp() });
        tx.update(others[0].ref, { isHost: true });
      } else {
        tx.update(roomRef, { status: "ended", updatedAt: FieldValue.serverTimestamp() });
      }
    } else if (others.length < 1) {
      // fewer than 1 connected non-host player left — not enough to keep playing
      tx.update(roomRef, { status: "ended", updatedAt: FieldValue.serverTimestamp() });
    }
  });
  return { ok: true };
});

// ============================================================================
// startRound — THE security-critical function. Picks the word, the
// impostor(s), and the clue, server-side only. Writes each player's private
// info to a doc only that player's uid can read (see firestore.rules).
// Also used to start round 2, 3, ... (same function, guarded by round state).
// ============================================================================
exports.startRound = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = String((request.data || {}).roomId || "").trim().toUpperCase();
  if (!roomId) throw new HttpsError("invalid-argument", "חסר קוד משחק");
  const roomRef = db.collection("rooms").doc(roomId);

  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "החדר לא קיים");
  const room = roomSnap.data();
  if (room.hostUid !== uid) throw new HttpsError("permission-denied", "רק המארח יכול להתחיל סיבוב");

  if (room.status === "waiting") {
    // first round — fine
  } else if (room.status === "playing") {
    const prevRoundSnap = await roomRef.collection("rounds").doc(String(room.currentRound)).get();
    if (!prevRoundSnap.exists || prevRoundSnap.data().status !== "done") {
      throw new HttpsError("failed-precondition", "הסיבוב הנוכחי עוד לא הסתיים");
    }
    if (room.currentRound >= room.totalRounds) {
      throw new HttpsError("failed-precondition", "כל הסיבובים כבר שוחקו");
    }
  } else {
    throw new HttpsError("failed-precondition", "המשחק לא במצב שמאפשר להתחיל סיבוב");
  }

  const playersSnap = await roomRef.collection("players").where("connected", "==", true).get();
  const players = playersSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  if (players.length < room.impostorCount + 2) {
    throw new HttpsError("failed-precondition", `צריך לפחות ${room.impostorCount + 2} שחקנים מחוברים כדי להתחיל`);
  }

  const pool = buildPool(room.categories, room.customWords);
  if (pool.length === 0) throw new HttpsError("failed-precondition", "אין מילים בקטגוריות שנבחרו");
  const [word, clue] = pool[Math.floor(Math.random() * pool.length)];

  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const impostorUids = shuffled.slice(0, room.impostorCount).map((p) => p.uid);

  const nextRoundNum = (room.currentRound || 0) + 1;
  const roundRef = roomRef.collection("rounds").doc(String(nextRoundNum));

  const batch = db.batch();
  batch.set(roundRef, {
    status: "collecting",
    submittedCount: 0, votedCount: 0,
    associationsRevealed: false, votesRevealed: false,
    revealedWord: null, revealedImpostorUids: null, revealedImpostorNames: null,
    mostVotedUid: null, impostorCaught: null,
    guess: null, guessCorrect: null,
    startedAt: FieldValue.serverTimestamp(),
  });
  batch.set(roundRef.collection("secret").doc("data"), { word, clue, impostorUids });
  players.forEach((p) => {
    const isImpostor = impostorUids.includes(p.uid);
    batch.set(roundRef.collection("private").doc(p.uid), {
      isImpostor,
      word: isImpostor ? null : word,
      clue: isImpostor ? clue : null,
    });
  });
  batch.update(roomRef, { status: "playing", currentRound: nextRoundNum, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  return { round: nextRoundNum };
});

// ============================================================================
// submitAssociation — one per player per round. Once every connected player
// has submitted, associations become readable (round.associationsRevealed)
// and voting opens.
// ============================================================================
exports.submitAssociation = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const roomId = String(data.roomId || "").trim().toUpperCase();
  const text = String(data.text || "").trim().slice(0, 60);
  if (!roomId) throw new HttpsError("invalid-argument", "חסר קוד משחק");
  if (!text) throw new HttpsError("invalid-argument", "כתבו אסוציאציה");

  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) throw new HttpsError("not-found", "החדר לא קיים");
    const room = roomSnap.data();
    const roundRef = roomRef.collection("rounds").doc(String(room.currentRound));
    const roundSnap = await tx.get(roundRef);
    if (!roundSnap.exists) throw new HttpsError("not-found", "אין סיבוב פעיל");
    const round = roundSnap.data();
    if (round.status !== "collecting") throw new HttpsError("failed-precondition", "לא ניתן לשלוח אסוציאציה כרגע");

    const playerRef = roomRef.collection("players").doc(uid);
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists) throw new HttpsError("permission-denied", "אתם לא בחדר הזה");

    const assocRef = roundRef.collection("associations").doc(uid);
    const assocSnap = await tx.get(assocRef);
    if (assocSnap.exists) throw new HttpsError("already-exists", "כבר שלחתם אסוציאציה");

    const connectedSnap = await tx.get(roomRef.collection("players").where("connected", "==", true));
    const connectedCount = connectedSnap.size;

    // -- reads are done; only writes from here --
    tx.set(assocRef, { name: playerSnap.data().name, text, submittedAt: FieldValue.serverTimestamp() });
    const newCount = (round.submittedCount || 0) + 1;
    const patch = { submittedCount: newCount };
    if (newCount >= connectedCount) {
      patch.status = "voting";
      patch.associationsRevealed = true;
    }
    tx.update(roundRef, patch);
  });
  return { ok: true };
});

// ============================================================================
// submitVote — hidden until every connected player has voted; then tallied
// and revealed here, server-side, in the same transaction.
// ============================================================================
exports.submitVote = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const roomId = String(data.roomId || "").trim().toUpperCase();
  const votedForUid = String(data.votedForUid || "").trim();
  if (!roomId) throw new HttpsError("invalid-argument", "חסר קוד משחק");
  if (!votedForUid) throw new HttpsError("invalid-argument", "בחרו שחקן");

  const roomRef = db.collection("rooms").doc(roomId);
  let outcome = null;

  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) throw new HttpsError("not-found", "החדר לא קיים");
    const room = roomSnap.data();
    const roundRef = roomRef.collection("rounds").doc(String(room.currentRound));
    const roundSnap = await tx.get(roundRef);
    if (!roundSnap.exists) throw new HttpsError("not-found", "אין סיבוב פעיל");
    const round = roundSnap.data();
    if (round.status !== "voting") throw new HttpsError("failed-precondition", "לא ניתן להצביע כרגע");

    const voteRef = roundRef.collection("votes").doc(uid);
    const voteSnap = await tx.get(voteRef);
    if (voteSnap.exists) throw new HttpsError("already-exists", "כבר הצבעתם");

    const targetSnap = await tx.get(roomRef.collection("players").doc(votedForUid));
    if (!targetSnap.exists) throw new HttpsError("invalid-argument", "שחקן לא קיים");

    const connectedSnap = await tx.get(roomRef.collection("players").where("connected", "==", true));
    const connectedCount = connectedSnap.size;
    const priorVotesSnap = await tx.get(roundRef.collection("votes"));
    const secretSnap = await tx.get(roundRef.collection("secret").doc("data"));
    const secret = secretSnap.data();
    const allPlayersSnap = await tx.get(roomRef.collection("players"));

    // -- reads done, writes below --
    tx.set(voteRef, { votedForUid, votedAt: FieldValue.serverTimestamp() });
    const newVotedCount = (round.votedCount || 0) + 1;
    const patch = { votedCount: newVotedCount };

    if (newVotedCount >= connectedCount) {
      const tally = {};
      priorVotesSnap.docs.forEach((d) => {
        const v = d.data().votedForUid;
        tally[v] = (tally[v] || 0) + 1;
      });
      tally[votedForUid] = (tally[votedForUid] || 0) + 1;

      let maxVotes = -1, maxUid = null, tie = false;
      Object.entries(tally).forEach(([playerUid, count]) => {
        if (count > maxVotes) { maxVotes = count; maxUid = playerUid; tie = false; }
        else if (count === maxVotes) { tie = true; }
      });
      const caught = !tie && secret.impostorUids.includes(maxUid);
      const nameByUid = {};
      allPlayersSnap.docs.forEach((d) => { nameByUid[d.id] = d.data().name; });

      patch.status = caught ? "guessing" : "revealed";
      patch.votesRevealed = true;
      patch.revealedWord = secret.word;
      patch.revealedImpostorUids = secret.impostorUids;
      patch.revealedImpostorNames = secret.impostorUids.map((u) => nameByUid[u] || "?");
      patch.mostVotedUid = tie ? null : maxUid;
      patch.impostorCaught = caught;

      outcome = { caught };
    }
    tx.update(roundRef, patch);
  });

  // if the impostor evaded (not caught), the round resolves immediately —
  // no guessing phase. If caught, we wait for guessWord() instead.
  if (outcome && !outcome.caught) {
    await resolveRoundScoring(roomId, undefined);
  }
  return { ok: true };
});

// ============================================================================
// guessWord — the impostor's last chance, only callable after being caught.
// ============================================================================
exports.guessWord = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const roomId = String(data.roomId || "").trim().toUpperCase();
  const guess = String(data.guess || "").trim();
  if (!roomId) throw new HttpsError("invalid-argument", "חסר קוד משחק");
  if (!guess) throw new HttpsError("invalid-argument", "כתבו ניחוש");

  const roomRef = db.collection("rooms").doc(roomId);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "החדר לא קיים");
  const room = roomSnap.data();
  const roundRef = roomRef.collection("rounds").doc(String(room.currentRound));
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) throw new HttpsError("not-found", "אין סיבוב פעיל");
  if (roundSnap.data().status !== "guessing") throw new HttpsError("failed-precondition", "לא זמן לניחוש");

  const secretSnap = await roundRef.collection("secret").doc("data").get();
  const secret = secretSnap.data();
  if (!secret.impostorUids.includes(uid)) throw new HttpsError("permission-denied", "רק המתחזה שנתפס מנחש");

  await resolveRoundScoring(roomId, guess);
  return { ok: true };
});

/**
 * Shared ending for a round: awards points and marks the round (and, if this
 * was the last round, the whole room) done. `guess` is undefined when the
 * impostor evaded without being caught; a string when they guessed.
 *
 * Scoring (deliberately simple — see task notes for how to extend it):
 *   impostor evades, or is caught but guesses the word correctly -> impostor(s) +1
 *   impostor is caught and guesses wrong                          -> everyone else +1
 */
async function resolveRoundScoring(roomId, guess) {
  const roomRef = db.collection("rooms").doc(roomId);
  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    const room = roomSnap.data();
    const roundRef = roomRef.collection("rounds").doc(String(room.currentRound));
    const roundSnap = await tx.get(roundRef);
    const round = roundSnap.data();
    const secretSnap = await tx.get(roundRef.collection("secret").doc("data"));
    const secret = secretSnap.data();
    const playersSnap = await tx.get(roomRef.collection("players"));

    let guessCorrect = null;
    let impostorWon;
    if (guess !== undefined) {
      guessCorrect = normalizeWord(guess) === normalizeWord(secret.word);
      impostorWon = guessCorrect;
    } else {
      impostorWon = true; // never caught
    }

    playersSnap.docs.forEach((d) => {
      const isImpostor = secret.impostorUids.includes(d.id);
      if (isImpostor === impostorWon) tx.update(d.ref, { score: FieldValue.increment(1) });
    });

    const roundPatch = { status: "done" };
    if (guess !== undefined) {
      roundPatch.guess = guess;
      roundPatch.guessCorrect = guessCorrect;
      // evasion case already set these in submitVote; guessing case sets them now
      roundPatch.revealedWord = secret.word;
      roundPatch.revealedImpostorUids = secret.impostorUids;
    }
    tx.update(roundRef, roundPatch);

    const roomPatch = { updatedAt: FieldValue.serverTimestamp() };
    if (room.currentRound >= room.totalRounds) roomPatch.status = "ended";
    tx.update(roomRef, roomPatch);
  });
}
