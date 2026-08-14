# -*- coding: utf-8 -*-
import io,sys
h=io.open("index.html",encoding="utf-8").read()
def rep(old,new,label):
    global h
    if old not in h: print("MISSING:",label); sys.exit(1)
    if h.count(old)!=1: print("NOT UNIQUE(%d):"%h.count(old),label); sys.exit(1)
    h=h.replace(old,new); print("ok:",label)

# CSS: starter box
rep('.revealBox .v.imp{color:#e23b3b}',
    '.revealBox .v.imp{color:#e23b3b}\n.starterBox{text-align:center; font-size:27px; font-weight:800; background:var(--panel); border:2px solid var(--btn-hover); border-radius:18px; padding:20px; margin:6px 0 4px; color:var(--btn-hover)}',
    "css-starter")

# GAME section: add starter line
rep('''  <h1>מצאו את המתחזה!</h1>
  <p class="sub">דונו, חקרו, והצביעו</p>
  <div style="margin-top:30px">''',
    '''  <h1>מצאו את המתחזה!</h1>
  <p class="sub">דונו, חקרו, והצביעו</p>
  <div id="starter" class="starterBox"></div>
  <div style="margin-top:14px">''',
    "html-starter")

# customWords + usedWords load from localStorage
rep('let customWords = []; // array of strings',
    '''let customWords = [];
try{ customWords = JSON.parse(localStorage.getItem('impostor_custom')||'[]'); }catch(e){ customWords=[]; }
let usedWords = new Set();
try{ usedWords = new Set(JSON.parse(localStorage.getItem('impostor_used')||'[]')); }catch(e){}
function saveUsed(){ try{ localStorage.setItem('impostor_used', JSON.stringify([...usedWords])); }catch(e){} }''',
    "storage-load")

# saveCustom: persist custom words
rep('''  if(customWords.length>0) selCats.add(CUSTOM_KEY); else selCats.delete(CUSTOM_KEY);
  buildCats(); show('home');''',
    '''  if(customWords.length>0) selCats.add(CUSTOM_KEY); else selCats.delete(CUSTOM_KEY);
  try{ localStorage.setItem('impostor_custom', JSON.stringify(customWords)); }catch(e){}
  buildCats(); show('home');''',
    "save-custom")

# startDeal: skip used words + pick starter
old_deal='''function startDeal(){
  const pool=getPool();
  const pick=pool[Math.floor(Math.random()*pool.length)];
  state.word=pick[0]; const clue=pick[1];
  // choose impostors
  let idxs=shuffle([...Array(state.names.length).keys()]).slice(0,state.impostors);
  state.impNames=idxs.map(i=>state.names[i]);
  state.assignments=state.names.map((name,i)=>({
    name, isImp:idxs.includes(i), word:state.word, clue
  }));
  state.cardIndex=0;
  show('cards');
  renderCard();
}'''
new_deal='''function startDeal(){
  const pool=getPool();
  // remember which words were already used; serve only unused ones
  let avail=pool.filter(p=>!usedWords.has(p[0]));
  if(avail.length===0){ pool.forEach(p=>usedWords.delete(p[0])); avail=pool; }
  const pick=avail[Math.floor(Math.random()*avail.length)];
  state.word=pick[0]; const clue=pick[1];
  usedWords.add(state.word); saveUsed();
  // choose impostors
  let idxs=shuffle([...Array(state.names.length).keys()]).slice(0,state.impostors);
  state.impNames=idxs.map(i=>state.names[i]);
  state.assignments=state.names.map((name,i)=>({
    name, isImp:idxs.includes(i), word:state.word, clue
  }));
  // pick a random player to start the round
  state.starter=state.names[Math.floor(Math.random()*state.names.length)];
  document.getElementById('starter').textContent=state.starter+' מתחיל!';
  state.cardIndex=0;
  show('cards');
  renderCard();
}'''
rep(old_deal,new_deal,"startDeal")

io.open("index.html","w",encoding="utf-8").write(h)
print("WROTE OK")
