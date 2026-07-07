// app.js — the Design Space shell: vault docs (nav/view/edit), mind-map, build view, expert team
// chat, cascade surfacing, theme, boot. The Map Studio lives in map.js; shared mutable state and
// the late-binding function registry live in store.js (no module cycles — map.js reaches the
// shell only through S.fn).

import { esc, titleCaseName } from "./util.js";
import { S } from "./store.js";
import { postJSON } from "./net.js";
import { renderMap } from "./map.js";

const KIND_ICON = { home:"⌂", concept:"◆", "art-direction":"✦", "world-bible":"◈", cast:"☗", storyboard:"❧", "build-map":"⚑" };
const KIND_LABEL = { home:"Home", concept:"Concept", "art-direction":"Art", "world-bible":"World", cast:"Cast", storyboard:"Beats", "build-map":"Build map" };
const NODE_COLOR = { region:"#dfeadf", location:"#e2eef0", player:"#e7e0f0", npc:"#f6ecdd", creature:"#f0dede", beat:"#e6ecf2" };
const NODE_STROKE = { region:"#3f7d57", location:"#2f6f7a", player:"#6d5f7a", npc:"#b9772b", creature:"#a25151", beat:"#5c6773" };
const TEAM = [
  { id:"concept", nm:"Game Designer", rl:"Concept & pillars", owns:"concept.md", c:"#2f6f7a" },
  { id:"artDirection", nm:"Art Director", rl:"Look, palette, mood", owns:"art-direction.md", c:"#b9772b" },
  { id:"world", nm:"Worldbuilder", rl:"Regions, locations, map", owns:"world-bible.md", c:"#3f7d57" },
  { id:"cast", nm:"Casting Director", rl:"Player, NPCs, creatures", owns:"cast.md", c:"#a25151" },
  { id:"storyboard", nm:"Narrative Designer", rl:"Beats & journey", owns:"storyboard.md", c:"#6d5f7a" },
  { id:"architect", nm:"Architect", rl:"Global coherence · routes cascades", owns:"— watches all —", c:"#1b2126" },
];

function frontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const props = {};
  if (m) for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (mm && !/^\s/.test(line)) props[mm[1]] = mm[2].replace(/^["']|["']$/g, "");
  }
  return { props, body: m ? content.slice(m[0].length) : content };
}
function kindOf(content) { return frontmatter(content).props.kind || "doc"; }

// ---- compact markdown renderer ----
function inline(s){
  s = esc(s);
  s = s.replace(/`([^`]+)`/g,(_,c)=>"<code>"+c+"</code>");
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,(_,t,a)=>wl(t,a));
  s = s.replace(/\[\[([^\]]+)\]\]/g,(_,t)=>wl(t,t));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g,"$1<em>$2</em>");
  return s;
}
function wl(target, alias){
  const doc = target.split("#")[0].trim();
  const file = /\.md$/.test(doc) ? doc : doc + ".md";
  const exists = S.state && S.state.docs.some(d=>d.name===file || d.name===doc || d.name.replace(/\.md$/,"")===doc);
  return '<a class="wl'+(exists?"":" missing")+'" data-doc="'+esc(file)+'">'+esc(alias.replace(/\\\|/g,"|"))+"</a>";
}
function renderMd(src){
  const lines = src.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").split("\n");
  let html="", i=0;
  const closeList=()=>{ if(list){ html+="</"+list+">"; list=null; } };
  let list=null;
  while(i<lines.length){
    let ln = lines[i];
    if(/^```/.test(ln)){ closeList(); let code=""; i++; while(i<lines.length && !/^```/.test(lines[i])){ code+=esc(lines[i])+"\n"; i++; } html+="<pre><code>"+code+"</code></pre>"; i++; continue; }
    if(/^\s*$/.test(ln)){ closeList(); i++; continue; }
    let h = ln.match(/^(#{1,4})\s+(.*)$/);
    if(h){ closeList(); html+="<h"+h[1].length+">"+inline(h[2])+"</h"+h[1].length+">"; i++; continue; }
    if(/^>\s?/.test(ln)){ closeList(); let q=""; while(i<lines.length && /^>\s?/.test(lines[i])){ q+=lines[i].replace(/^>\s?/,"")+" "; i++; } html+="<blockquote>"+inline(q.trim())+"</blockquote>"; continue; }
    if(/^(-{3,}|\*{3,})\s*$/.test(ln)){ closeList(); html+="<hr>"; i++; continue; }
    if(/^\s*\|.*\|\s*$/.test(ln) && i+1<lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i+1])){
      closeList();
      const row=(r)=>r.trim().replace(/^\||\|$/g,"").split("|").map(c=>c.trim());
      const head=row(ln); i+=2; let body="";
      while(i<lines.length && /^\s*\|.*\|\s*$/.test(lines[i])){ body+="<tr>"+row(lines[i]).map(c=>"<td>"+inline(c)+"</td>").join("")+"</tr>"; i++; }
      html+="<table><thead><tr>"+head.map(c=>"<th>"+inline(c)+"</th>").join("")+"</tr></thead><tbody>"+body+"</tbody></table>";
      continue;
    }
    let ul = ln.match(/^\s*[-*]\s+(.*)$/), ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if(ul){ if(list!=="ul"){ closeList(); html+="<ul>"; list="ul"; } html+="<li>"+inline(ul[1])+"</li>"; i++; continue; }
    if(ol){ if(list!=="ol"){ closeList(); html+="<ol>"; list="ol"; } html+="<li>"+inline(ol[1])+"</li>"; i++; continue; }
    closeList(); html+="<p>"+inline(ln)+"</p>"; i++;
  }
  closeList(); return html;
}

// ---- views ----
function renderNav(){
  const nav = document.getElementById("nav");
  const order = ["home","concept","art-direction","world-bible","cast","storyboard","build-map"];
  const docs = [...S.state.docs].sort((a,b)=> order.indexOf(kindOf(a.content)) - order.indexOf(kindOf(b.content)));
  nav.innerHTML = docs.map(d=>{
    const k = kindOf(d.content);
    return '<div class="navitem'+(d.name===S.activeDoc?" active":"")+'" data-doc="'+d.name+'">'
      +'<span class="ic">'+(KIND_ICON[k]||"◦")+'</span><span class="t">'+titleOf(d)+'</span>'
      +'<span class="k">'+(KIND_LABEL[k]||"")+'</span></div>';
  }).join("");
  nav.querySelectorAll(".navitem").forEach(el=>el.onclick=()=>openDoc(el.dataset.doc));
}
function titleOf(d){ const p=frontmatter(d.content).props; return p.title || p.name || titleCaseName(d.name.replace(/\.md$/,"")); }

function openDoc(name){
  S.activeView="docs"; setTabs(); S.activeDoc=name;
  const d = S.state.docs.find(x=>x.name===name) || S.state.docs[0];
  if(!d){ return; }
  S.activeDoc = d.name;
  const { props } = frontmatter(d.content);
  const chips = Object.entries(props).filter(([k])=>k!=="note").slice(0,6)
    .map(([k,v])=>'<span class="prop"><b>'+k+'</b> '+esc(String(v)).slice(0,42)+'</span>').join("");
  const editable = kindOf(d.content)!=="build-map";
  document.getElementById("center").innerHTML =
    '<div class="doc-wrap">'
    +(editable?'<div class="doc-edit"><button class="btn" id="doc-edit">✎ Edit</button> <button class="btn" id="doc-del" title="Delete document">🗑</button></div>':'')
    +'<div class="props">'+chips+'</div><div class="doc">'+renderMd(d.content)+'</div></div>';
  document.querySelectorAll(".doc a.wl").forEach(a=>{ if(a.dataset.doc) a.onclick=(e)=>{e.preventDefault(); openDoc(a.dataset.doc);}; });
  const eb=document.getElementById("doc-edit"); if(eb) eb.onclick=()=>openEditor(S.activeDoc);
  const dd=document.getElementById("doc-del"); if(dd) dd.onclick=()=>deleteDoc(S.activeDoc);
  renderNav();
  if(chatAgent) updateChatCtx();
}

function renderGraph(){
  const g = S.state.graph || {nodes:[],edges:[]};
  const W=900,H=560,cx=W/2,cy=H/2+10,R=Math.min(W,H)/2-90;
  const order=["region","location","player","npc","creature","beat"];
  const nodes=[...g.nodes].sort((a,b)=>order.indexOf(a.type)-order.indexOf(b.type));
  const pos={}; nodes.forEach((n,k)=>{ const a=(k/nodes.length)*2*Math.PI - Math.PI/2; pos[n.id]={x:cx+R*Math.cos(a),y:cy+R*Math.sin(a)}; });
  const edges = (g.edges||[]).map(e=>{ const A=pos[e.from],B=pos[e.to]; if(!A||!B) return "";
    const mx=(A.x+B.x)/2,my=(A.y+B.y)/2;
    return '<path class="gedge" d="M'+A.x+' '+A.y+' Q '+cx+' '+cy+' '+B.x+' '+B.y+'"/>'
      +'<text class="gedge-label" x="'+((A.x+cx)/2*0+mx)+'" y="'+my+'">'+esc(e.label)+'</text>'; }).join("");
  const gn = nodes.map(n=>{ const p=pos[n.id]; const w=Math.min(150,28+n.label.length*6.6);
    return '<g class="gnode" transform="translate('+(p.x-w/2)+','+(p.y-13)+')">'
      +'<rect width="'+w+'" height="26" fill="'+(NODE_COLOR[n.type]||"#eee")+'" stroke="'+(NODE_STROKE[n.type]||"#999")+'"/>'
      +'<text x="'+w/2+'" y="17" text-anchor="middle">'+esc(n.label)+'</text></g>'; }).join("");
  const legend = order.filter(t=>nodes.some(n=>n.type===t)).map(t=>'<span><i style="background:'+NODE_COLOR[t]+';border:1px solid '+NODE_STROKE[t]+'"></i>'+t+'</span>').join("");
  document.getElementById("center").innerHTML =
    '<div class="graph-wrap"><div class="graph-head"><h2>Mind-map</h2>'
    +'<p>Generated from the vault’s own links — '+nodes.length+' nodes, '+(g.edges||[]).length+' typed relationships. This is also the cascade graph.</p></div>'
    +'<div class="legend">'+legend+'</div>'
    +'<svg viewBox="0 0 '+W+' '+H+'">'+edges+gn+'</svg></div>';
}

function renderBuild(){
  const b = S.state.build || {placements:[],links:[]};
  const built = (b.links||[]).filter(l=>l.buildId).length;
  const rows = (b.links||[]).map(l=>'<tr><td>'+esc(l.name)+'</td><td>'+esc(l.doc)+'</td><td>'
    +(l.buildId?'<span class="bid">'+esc(l.buildId)+'</span>':'<span class="bid unbuilt">unbuilt</span>')+'</td></tr>').join("");
  document.getElementById("center").innerHTML =
    '<div class="build-wrap"><h2>Build</h2>'
    +'<div class="kpis">'
    +'<div class="kpi"><div class="n">'+(b.placements||[]).length+'</div><div class="l">placements</div></div>'
    +'<div class="kpi"><div class="n">'+built+'/'+(b.links||[]).length+'</div><div class="l">doc ↔ build links</div></div>'
    +'<div class="kpi"><div class="n">'+(b.ok?"✓":"—")+'</div><div class="l">compiles</div></div></div>'
    +'<table class="build"><thead><tr><th>Design entity</th><th>From</th><th>Where in the build</th></tr></thead><tbody>'+rows+'</tbody></table>'
    +'<p style="color:var(--muted);font-size:12.5px;margin-top:16px">These are the compiled placements — where each thing goes. The buildings are still <b>unbuilt</b> GLBs until the 3D build step renders them.</p></div>';
}

function renderTeam(){
  document.getElementById("team").innerHTML = TEAM.map(a=>
    '<div class="agent" data-agent="'+a.id+'"><div class="av" style="background:'+a.c+'">'+a.nm[0]+'</div>'
    +'<div><div class="nm">'+a.nm+'</div><div class="rl">'+a.rl+'</div><div class="owns">'+a.owns+'</div></div></div>').join("");
  document.querySelectorAll(".agent").forEach(el=>el.onclick=()=>openChat(el.dataset.agent));
}

// ---- expert chat ----
let chatAgent=null, chatHist=[];
function openChat(id){
  chatAgent = TEAM.find(a=>a.id===id); chatHist=[];
  document.getElementById("chat-av").style.background=chatAgent.c;
  document.getElementById("chat-av").textContent=chatAgent.nm[0];
  document.getElementById("chat-nm").textContent=chatAgent.nm;
  document.getElementById("chat-rl").textContent=chatAgent.rl;
  document.getElementById("chat-msgs").innerHTML="";
  updateChatCtx();
  pushMsg("sys","Talking to the "+chatAgent.nm+". They have full context for their role — persona, the document they own"
    +(chatAgent.id==="architect"?" (all documents)":"")+", the upstream docs they depend on, and the document you're viewing.");
  document.getElementById("chat").classList.add("open");
  document.getElementById("chat-input").focus();
}
function closeChat(){ document.getElementById("chat").classList.remove("open"); chatAgent=null; }
function updateChatCtx(){
  document.getElementById("chat-ctx").innerHTML = "sees you viewing <b>"+(S.activeDoc||"—")+"</b> · view: <b>"+S.activeView+"</b>";
}
function pushMsg(kind,text){
  const el=document.createElement("div"); el.className="msg "+kind; el.textContent=text;
  const box=document.getElementById("chat-msgs"); box.appendChild(el); box.scrollTop=box.scrollHeight; return el;
}
async function sendChat(){
  const ta=document.getElementById("chat-input"); const text=ta.value.trim();
  if(!text||!chatAgent) return; ta.value="";
  pushMsg("user",text); chatHist.push({role:"user",content:text});
  const typing=pushMsg("typing",chatAgent.nm+" is thinking…");
  document.getElementById("chat-send").disabled=true;
  try{
    const j=await postJSON("/api/agent",{agentId:chatAgent.id, message:text, history:chatHist.slice(0,-1),
      screen:{openDoc:S.activeDoc, activeAgent:chatAgent.id}});
    typing.remove();
    pushMsg(j.ok===false?"sys":"agent", j.reply||"(no reply)");
    if(j.ok!==false) chatHist.push({role:"assistant",content:j.reply});
  }catch(e){ typing.remove(); pushMsg("sys","⚠ "+e); }
  document.getElementById("chat-send").disabled=false;
}

// ---- create / delete documents ----
function newDocDialog(){
  document.getElementById("insp")?.remove();
  const kinds=["note","lore","faction","location","character","concept","art-direction","world-bible","cast","storyboard"];
  const el=document.createElement("div"); el.className="insp"; el.id="insp";
  el.style.left="50%"; el.style.top="120px"; el.style.right="auto"; el.style.transform="translateX(-50%)";
  el.innerHTML='<h4>New document<button class="x" id="insp-x">×</button></h4>'
    +'<label>Title</label><input id="nd-title" placeholder="e.g. The Wardens">'
    +'<label>Kind</label><select id="nd-kind">'+kinds.map(k=>'<option'+(k==="note"?" selected":"")+'>'+k+'</option>').join("")+'</select>'
    +'<div class="co">A readable, linkable markdown doc. "note" and lore/faction/etc. are free notes; the design kinds feed the build.</div>'
    +'<div class="actions"><button class="save" id="nd-create">Create</button></div>';
  document.body.appendChild(el);
  document.getElementById("insp-x").onclick=()=>el.remove();
  document.getElementById("nd-title").focus();
  document.getElementById("nd-title").addEventListener("keydown",e=>{ if(e.key==="Enter") createDocNow(); });
  document.getElementById("nd-create").onclick=createDocNow;
}
async function createDocNow(){
  const title=document.getElementById("nd-title").value.trim(), kind=document.getElementById("nd-kind").value;
  if(!title){ document.getElementById("nd-title").focus(); return; }
  try{ const j=await postJSON("/api/doc-create",{title,kind});
    if(j.error){ pushToast(j.error); return; }
    document.getElementById("insp")?.remove(); await load(); S.activeView="docs"; setTabs(); openDoc(j.name); openEditor(j.name);
  }catch(e){ pushToast("create failed: "+e); } }
async function deleteDoc(name){
  if(!name) return;
  if(!confirm("Delete '"+name+"'? This removes the file. (world-bible / cast / storyboard feed the build.)")) return;
  try{ const j=await postJSON("/api/doc-delete",{name});
    if(j.error){ pushToast(j.error); return; }
    S.activeDoc=null; await load(); const first=(S.state.docs.find(d=>kindOf(d.content)==="home")||S.state.docs[0]); if(first) openDoc(first.name);
  }catch(e){ pushToast("delete failed: "+e); } }

// ---- full markdown editor + save -> cascade surfacing ----
function openEditor(name){
  const d = S.state.docs.find(x=>x.name===name); if(!d) return;
  document.getElementById("center").innerHTML =
    '<div class="ed"><div class="ed-bar"><span class="fn">'+name+'</span><span class="sp"></span>'
    +'<button class="btn" id="ed-cancel">Cancel</button><button class="btn ed-save" id="ed-save">Save</button></div>'
    +'<div class="ed-split"><textarea id="ed-ta" spellcheck="false"></textarea><div class="ed-prev col" id="ed-prev"></div></div></div>';
  const ta=document.getElementById("ed-ta"); ta.value=d.content;
  const prev=document.getElementById("ed-prev");
  const render=()=>{ prev.innerHTML='<div class="doc-wrap"><div class="doc">'+renderMd(ta.value)+'</div></div>'; };
  render(); ta.addEventListener("input",render);
  document.getElementById("ed-cancel").onclick=()=>openDoc(name);
  document.getElementById("ed-save").onclick=()=>saveEditor(name, ta.value);
}
async function saveEditor(name, content){
  const btn=document.getElementById("ed-save"); if(btn){ btn.disabled=true; btn.textContent="Saving…"; }
  try{
    const j=await postJSON("/api/save",{name,content});
    const d=S.state.docs.find(x=>x.name===name); if(d) d.content=content;
    await load(); S.activeDoc=name; S.activeView="docs"; setTabs(); openDoc(name);
    if(j.impacts && j.impacts.length) surfaceCascade(j.impacts);
  }catch(e){ if(btn){ btn.disabled=false; btn.textContent="Save"; } pushToast("save failed: "+e); }
}
function pushToast(m){ console.warn(m); }
function surfaceCascade(impacts){
  const old=document.getElementById("cascade"); if(old) old.remove();
  const src = impacts[0].source ? impacts[0].source.name : (impacts[0].change.entityId||"the design");
  const seen=new Set(); const items=[];
  for(const im of impacts) for(const a of im.affected){ if(!seen.has(a.id)){ seen.add(a.id); items.push(a); } }
  if(items.length===0) return;
  const el=document.createElement("div"); el.className="cascade"; el.id="cascade";
  el.innerHTML='<h4>⚑ You changed '+esc(src)+' — review the cascade<button class="cx" id="casc-x">×</button></h4>'
    +'<div class="sum">'+esc(impacts[0].summary)+'</div>'
    +items.map(a=>'<div class="item"><span class="nm">'+esc(a.name)+'</span><span class="rel">'+esc(a.relation)+'</span>'
      +'<button class="go" data-agent="'+esc(a.expertId)+'">Talk to '+esc(a.expertRole)+'</button></div>').join("");
  document.body.appendChild(el);
  document.getElementById("casc-x").onclick=()=>el.remove();
  el.querySelectorAll(".go").forEach(b=>b.onclick=()=>openChat(b.dataset.agent));
}

function setTabs(){ document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===S.activeView)); }
function showView(){
  if(S.activeView==="docs") openDoc(S.activeDoc || (S.state.docs[0]&&S.state.docs[0].name));
  else if(S.activeView==="map") renderMap();
  else if(S.activeView==="graph") renderGraph();
  else renderBuild();
  if(chatAgent) updateChatCtx();
}

// ---- boot ----
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{ S.activeView=t.dataset.view; setTabs(); showView(); });
document.getElementById("refresh").onclick=()=>load();
document.getElementById("new-doc").onclick=newDocDialog;

const themeBtn=document.getElementById("theme");
function applyTheme(t){ document.body.classList.toggle("dark",t==="dark"); themeBtn.textContent=t==="dark"?"☀":"🌙"; }
let theme=localStorage.getItem("design-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
applyTheme(theme);
themeBtn.onclick=()=>{ theme=document.body.classList.contains("dark")?"light":"dark"; localStorage.setItem("design-theme",theme); applyTheme(theme); };

document.getElementById("chat-x").onclick=closeChat;
document.getElementById("chat-send").onclick=sendChat;
document.getElementById("chat-input").addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendChat(); } });

async function load(){
  const r = await fetch("/api/state"); S.state = await r.json();
  document.getElementById("projname").textContent = titleCaseName(S.state.project||"Design Space");
  document.title = document.getElementById("projname").textContent + " — Design Space";
  renderTeam(); renderNav();
  const home = S.state.docs.find(d=>kindOf(d.content)==="home");
  if(!S.activeDoc) S.activeDoc = home ? home.name : (S.state.docs[0]&&S.state.docs[0].name);
  showView();
}

// Late-bind the shell functions map.js needs (see store.js — avoids app<->map import cycles).
S.fn.reload = load;
S.fn.surfaceCascade = surfaceCascade;
S.fn.updateChatCtx = updateChatCtx;
S.fn.chatOpen = () => !!chatAgent;

load();
