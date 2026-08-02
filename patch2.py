# -*- coding: utf-8 -*-
import io,sys
h=io.open("index.html",encoding="utf-8").read()
def rep(old,new,label):
    global h
    if old not in h: print("MISSING:",label); sys.exit(1)
    if h.count(old)!=1: print("NOT UNIQUE(%d):"%h.count(old),label); sys.exit(1)
    h=h.replace(old,new); print("ok:",label)

# 1) add custom screen HTML before <!-- CARDS -->
rep('<!-- CARDS -->',
'''<!-- CUSTOM -->
<section id="custom" class="screen">
  <h1 style="font-size:26px">קטגוריה מותאמת אישית</h1>
  <p class="sub">כתבו מילים בלבד — הרמז ייווצר אוטומטית כדי לא להסגיר לכם אותו</p>
  <div id="customList"></div>
  <button class="btn ghost" onclick="addCustomRow('')">+ הוסף מילה</button>
  <button class="btn" onclick="saveCustom()">שמור וחזרה</button>
</section>

<!-- CARDS -->''',"custom-html")

# 2) getPool -> sibling-hint for custom
old_pool='''function getPool(){
  let pool=[];
  document.querySelectorAll('.cat.sel').forEach(el=>{
    const c=el.dataset.cat;
    if(c===CUSTOM_KEY) pool=pool.concat(customWords);
    else pool=pool.concat(WORDS[c]);
  });
  return pool;
}'''
new_pool='''function getPool(){
  let pool=[];
  selCats.forEach(c=>{
    if(c===CUSTOM_KEY){
      customWords.forEach(w=>{
        const others=customWords.filter(x=>x!==w);
        const clue = others.length ? others[Math.floor(Math.random()*others.length)] : '—';
        pool.push([w,clue]);
      });
    } else pool=pool.concat(WORDS[c]);
  });
  return pool;
}'''
rep(old_pool,new_pool,"getPool")

# 3) buildCats + editCustom -> new implementation with selCats + custom screen
old_build='''function buildCats(){
  const box=document.getElementById('cats'); box.innerHTML='';
  const order=Object.keys(WORDS).slice(0,7); // first 7
  // arrange to match request: put custom + random appropriately; just list all 10
  const all=[...Object.keys(WORDS)];
  // insert custom before "דברים אקראיים"
  const list=[];
  Object.keys(WORDS).forEach(k=>{ if(k==="דברים אקראיים") list.push(CUSTOM_KEY); list.push(k); });
  list.forEach(cat=>{
    const el=document.createElement('div');
    el.className='cat'; el.dataset.cat=cat;
    let count = cat===CUSTOM_KEY ? customWords.length : WORDS[cat].length;
    el.innerHTML = cat + '<span class="cnt">'+(cat===CUSTOM_KEY?'הוסף מילים':(count+' מילים'))+'</span>';
    el.onclick=()=>{
      if(cat===CUSTOM_KEY){ editCustom(el); return; }
      el.classList.toggle('sel');
    };
    box.appendChild(el);
  });
}
function editCustom(el){
  const txt = prompt("הכניסו מילים לקטגוריה מותאמת אישית.\\nכל שורה: מילה, רמז\\n(למשל: כלב, נביחה)", customWords.map(w=>w[0]+", "+w[1]).join("\\n"));
  if(txt===null) return;
  customWords = txt.split("\\n").map(l=>l.split(",")).filter(p=>p[0]&&p[0].trim())
    .map(p=>[p[0].trim(), (p[1]||"").trim()||"—"]);
  el.querySelector('.cnt').textContent = customWords.length?('מותאם: '+customWords.length):'הוסף מילים';
  if(customWords.length) el.classList.add('sel'); else el.classList.remove('sel');
}
buildCats();'''
new_build='''const selCats = new Set();
function buildCats(){
  const box=document.getElementById('cats'); box.innerHTML='';
  const list=[];
  Object.keys(WORDS).forEach(k=>{ if(k==="דברים אקראיים") list.push(CUSTOM_KEY); list.push(k); });
  list.forEach(cat=>{
    const el=document.createElement('div');
    el.className='cat'; el.dataset.cat=cat;
    const count = cat===CUSTOM_KEY ? customWords.length : WORDS[cat].length;
    const sub = cat===CUSTOM_KEY ? (count?('מותאם: '+count+' מילים'):'לחצו להוספה') : (count+' מילים');
    el.innerHTML = cat + '<span class="cnt">'+sub+'</span>';
    if(selCats.has(cat)) el.classList.add('sel');
    el.onclick=()=>{
      if(cat===CUSTOM_KEY){ openCustom(); return; }
      if(selCats.has(cat)){ selCats.delete(cat); el.classList.remove('sel'); }
      else { selCats.add(cat); el.classList.add('sel'); }
    };
    box.appendChild(el);
  });
}
function openCustom(){
  const list=document.getElementById('customList'); list.innerHTML='';
  if(customWords.length===0) addCustomRow('');
  else customWords.forEach(w=>addCustomRow(w));
  show('custom');
}
function addCustomRow(val){
  const list=document.getElementById('customList');
  const row=document.createElement('div'); row.className='nameRow';
  const inp=document.createElement('input'); inp.placeholder='מילה'; inp.value=val||'';
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); addCustomRow(''); } });
  row.appendChild(inp); list.appendChild(row);
  if(!val) inp.focus();
}
function saveCustom(){
  customWords=[...document.querySelectorAll('#customList input')].map(i=>i.value.trim()).filter(Boolean);
  if(customWords.length>0) selCats.add(CUSTOM_KEY); else selCats.delete(CUSTOM_KEY);
  buildCats(); show('home');
}
buildCats();'''
rep(old_build,new_build,"buildCats")

# 4) customWords now holds strings
rep('let customWords = []; // array of [word, clue]','let customWords = []; // array of strings',"customWords-comment")

io.open("index.html","w",encoding="utf-8").write(h)
print("WROTE OK")
