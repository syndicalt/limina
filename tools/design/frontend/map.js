// map.js — the Map Studio view: 2D cartography over multiple hierarchical maps (world -> region ->
// city). Rendering + interaction only; the doc shape is owned by tools/design/map-doc.mjs, and
// EVERY cartography mutation goes through the pure command stack in map-commands.js so it is
// undoable (Ctrl+Z / Ctrl+Shift+Z, session-memory only). Markers are NOT commands: they live in
// the world-bible and flow through /api/edit-location with its own cascade surfacing.
//
// COORDINATE CONVENTION: north = -z, east = +x (right-handed, matches THREE's -z-forward default).
// North draws UP on screen, so screen-y grows as z grows: w2s's z term is `320 + (z-panz)*scale`
// (a `-` there is the old, mirrored +z=north convention that shipped a bug).

import { esc, toast } from "./util.js";
import { S } from "./store.js";
import { postJSON, bindMapSaver, bindSaveConflict, scheduleMapSave, flushMapSave } from "./net.js";
import * as H from "./map-commands.js";
import * as EL from "./map-elevation.js";
import * as LM from "./map-paint.js";

const KIND_FILL = { civic:"#3f7d57", dwelling:"#8a6f4a", religious:"#6d5f7a", military:"#a25151", marker:"#b9772b",
  settlement:"#3f7d57", landmark:"#2f6f7a", camp:"#b9772b", ruin:"#a25151", dungeon:"#6d5f7a", wild:"#7a8a6a" };
const KINDS = ["civic","dwelling","religious","military","marker","landmark","camp","ruin","wild"];
const GLYPHS = ["mountain","hills","forest","desert","marsh","water","peak"];
const GLYPH_LABEL = { mountain:"⛰ Mountains", hills:"⌒ Hills", forest:"♣ Forest", desert:"≈ Desert", marsh:"⍦ Marsh", water:"≋ Water", peak:"▲ Peak" };
const BIOME_LIST = ["grass","forest","mountain","desert","tundra","swamp","water"];
const BIOME_BASE = { grass:"#8aa85f", forest:"#4a7a45", mountain:"#8f8d88", desert:"#d9c48f", tundra:"#dbe4ea", swamp:"#6b7a55", water:"#3f6ea5" };
const SVGNS = "http://www.w3.org/2000/svg";

let mapPan={x:0,z:0}, mapScale=6, mapDrag=null, mapTool="select",
  drawColor="#5b7d9a", drawPts=[], activeMapId=null, selFeat=null, spaceDown=false, fittedMap=null;
// Elevation brush state (S1). A stroke = one undo step: full-buffer snapshot at stroke start,
// bbox-union of every dab, ONE cmdPatchRaster pushed {applied:true} at stroke end.
let elevMode="raise", elevRadius=12, elevStrength=0.6, elevLevelY=4;
// Landmass brush state (Painter P1). Same one-stroke-one-undo model as elevation.
let lmMode="land", lmRadius=100;
// Terrain (biome) brush state (Painter P2). Palette = the compiler's biome vocabulary.
let terKind="grass", terRadius=60;
// Stamp tool state (Painter P3): the REAL asset catalog, fetched once; the armed assetId.
let catalog=null, stampAssetId=null, selStamp=null;
// Layer visibility (P4): session-only view state — hiding a layer never touches the doc.
const hiddenLayers=new Set();
// World scale (zone.size_m) lives in the World Bible frontmatter — the Atlas surfaces and edits
// it in place, because it gates the Compile button (the no-silent-fitting scale contract).
function worldBibleDoc(){ return (S.state.docs||[]).find(d=>d.name==="world-bible.md"); }
function zoneSizeM(){ const d=worldBibleDoc(); const m=d&&d.content.match(/^\s*size_m:\s*(\d+(?:\.\d+)?)/m); return m?Number(m[1]):null; }
async function setZoneSizeM(v){
  const d=worldBibleDoc(); if(!d) return false;
  const next=d.content.replace(/^(\s*size_m:\s*)\d+(?:\.\d+)?/m, "$1"+Math.round(v));
  if(next===d.content) return false;
  await postJSON("/api/save",{name:d.name,content:next});
  d.content=next;
  return true;
}
const catalogById=()=>{ const m=new Map(); for(const c of catalog||[]) m.set(c.id,c); return m; };
async function loadCatalog(){
  if(catalog) return;
  try{ catalog = await (await fetch("/api/catalog")).json(); }catch{ catalog = []; }
  renderMap();
}
let elevShadeUrl=null, elevShadeFor=null; // cached hillshade data-URL + "mapId:seaLevel:rev" key
let elevRev=0; // bumped on every raster mutation (stroke dab, undo, redo)
// Collision-proof feature ids. The old counter (seeded off performance.now's STRING LENGTH) made
// separate sessions mint identical id sequences, so editing a new feature destroyed an old one
// sharing its id — one of the three phantom-feature-loss causes. Never mint sequential ids here.
const fid = () => "f-" + crypto.randomUUID();

// One history for the whole session; each command carries its mapId (undo on map A while viewing
// map B resolves A by id and still applies).
const history = H.createHistory(100);
const resolveMap = (id) => (S.state.maps || []).find((m) => m.id === id) || null;
function commit(cmd, opts) {
  if (!cmd) return;
  H.push(history, cmd, opts, resolveMap(cmd.mapId));
  scheduleMapSave(); redrawMap();
}
// Undo/redo announce what they touched: deep undo silently crossing from raster strokes into
// feature adds (deleting them) is how a held Ctrl+Z ate saved features.
function doUndo() { const c = H.undo(history, resolveMap); if (c) { selFeat = null; elevRev++; if(c.label==="import map layers") dropPaintCachesFor(c.mapId); reconcilePaintCaches(c.mapId); scheduleMapSave(); redrawMap(); toast("Undid: " + c.label); } }
function doRedo() { const c = H.redo(history, resolveMap); if (c) { selFeat = null; elevRev++; if(c.label==="import map layers") dropPaintCachesFor(c.mapId); reconcilePaintCaches(c.mapId); scheduleMapSave(); redrawMap(); toast("Redid: " + c.label); } }
/** Import swaps ENTIRE rasters wholesale — clean caches would go stale either direction. */
function dropPaintCachesFor(mapId){ EL.dropElevationCache(mapId); LM.dropLandmassCache(mapId); LM.dropBiomesCache(mapId); }

// Dirty rasters serialize into the doc at save-payload time (stroke-end debounce), never per dab.
bindMapSaver(() => { EL.syncElevationIntoDoc(S.state.maps); LM.syncLandmassIntoDoc(S.state.maps); LM.syncBiomesIntoDoc(S.state.maps); return { maps: S.state.maps, activeMapId }; });

// A save bounced 409: another session saved since this tab loaded. Reload the authoritative
// state instead of clobbering it — this tab's unsaved edits are dropped, visibly. Stale caches
// (decoded rasters, session history) must go with them.
bindSaveConflict(() => {
  history.undo.length = 0; history.redo.length = 0;
  for (const m of S.state.maps || []) EL.dropElevationCache(m.id);
  LM.dropAllPaintCaches();
  elevRev++;
  toast("Map changed in another session — reloading its version", 4000);
  S.fn.reload();
});

function biomeDefs(){
  const p=(id,base,ex)=>'<pattern id="biome-'+id+'" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="'+base+'"/>'+ex+'</pattern>';
  return '<defs>'
   +p("grass",BIOME_BASE.grass,'<path d="M3 12 v-3 M8 14 v-3 M13 11 v-3" stroke="#6e8a48" stroke-width="1"/>')
   +p("forest",BIOME_BASE.forest,'<circle cx="4" cy="5" r="2" fill="#365f32"/><circle cx="11" cy="9" r="2.4" fill="#2f5a2c"/><circle cx="8" cy="13" r="1.8" fill="#3a6636"/>')
   +p("mountain",BIOME_BASE.mountain,'<path d="M0 12 L4 5 L8 12 M8 13 L12 6 L16 13" stroke="#6f6d69" stroke-width="1" fill="none"/><path d="M4 6 l1.6 2 M12 7 l1.6 2" stroke="#efefec" stroke-width="1"/>')
   +p("desert",BIOME_BASE.desert,'<circle cx="4" cy="4" r=".9" fill="#bfa876"/><circle cx="11" cy="7" r=".9" fill="#bfa876"/><circle cx="7" cy="12" r=".9" fill="#bfa876"/>')
   +p("tundra",BIOME_BASE.tundra,'<circle cx="5" cy="6" r=".8" fill="#c3d0d8"/><circle cx="12" cy="11" r=".8" fill="#c3d0d8"/>')
   +p("swamp",BIOME_BASE.swamp,'<path d="M3 11 q2 -2 4 0 M9 13 q2 -2 4 0" stroke="#556442" stroke-width="1" fill="none"/>')
   +p("water",BIOME_BASE.water,'<path d="M0 5 q4 -2 8 0 t8 0 M0 11 q4 -2 8 0 t8 0" stroke="#5b86b8" stroke-width="1" fill="none"/>')
   +'</defs>';
}

// The viewBox is 1:1 with the container's CSS pixels and re-syncs on resize — a fixed 1000x640
// viewBox letterboxed on wide screens: content spilled into dead pillars past the coordinate
// space, the ocean rect stopped short, and the left-edge z ticks landed in the dead band.
let VBW=1000, VBH=640;
function syncViewBox(){
  const wrap=document.querySelector(".map-svg-wrap"), svg=document.getElementById("map-svg");
  if(!wrap||!svg) return false;
  const w=Math.max(200,wrap.clientWidth), h=Math.max(200,wrap.clientHeight);
  if(w===VBW&&h===VBH) return false;
  VBW=w; VBH=h;
  svg.setAttribute("viewBox","0 0 "+VBW+" "+VBH);
  return true;
}
function w2s(x,z){ return [VBW/2 + (x-mapPan.x)*mapScale, VBH/2 + (z-mapPan.z)*mapScale]; }
function s2w(sx,sy){ return [mapPan.x + (sx-VBW/2)/mapScale, mapPan.z + (sy-VBH/2)/mapScale]; }
function evtVB(e,svg){
  // Map client px -> viewBox coords via the SVG's own transform, so it stays exact regardless of
  // the letterboxing preserveAspectRatio adds when the element's aspect ratio differs from the
  // viewBox (1000:640). A naive rect-ratio mapping drifts.
  const m=svg.getScreenCTM();
  if(m){ const p=svg.createSVGPoint(); p.x=e.clientX; p.y=e.clientY; const q=p.matrixTransform(m.inverse()); return [q.x,q.y]; }
  const r=svg.getBoundingClientRect(); return [(e.clientX-r.left)/r.width*VBW, (e.clientY-r.top)/r.height*VBH];
}
function primaryMapId(){ return (S.state.maps&&S.state.maps[0]&&S.state.maps[0].id)||"primary"; }
function activeMap(){ return (S.state.maps||[]).find(m=>m.id===activeMapId) || (S.state.maps||[])[0] || {id:"primary",features:[]}; }
function curFeatures(){ const m=activeMap(); if(!Array.isArray(m.features)) m.features=[]; return m.features; }
function mapMarkers(){ const pid=primaryMapId(); return (S.state.world&&S.state.world.locations||[]).filter(l=> l.map ? l.map===activeMapId : activeMapId===pid); }

function glyphSVG(kind,x,y,s){
  const st='stroke="#6b6459" fill="none" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"';
  if(kind==="mountain") return `<path ${st} d="M${x-s} ${y+s*.5} L${x-s*.3} ${y-s*.6} L${x+s*.1} ${y} L${x+s*.5} ${y-s*.8} L${x+s} ${y+s*.5}"/>`;
  if(kind==="peak") return `<path ${st} d="M${x-s*.7} ${y+s*.5} L${x} ${y-s*.8} L${x+s*.7} ${y+s*.5}"/><path ${st} d="M${x-s*.15} ${y-s*.15} L${x} ${y-s*.8} L${x+s*.15} ${y-s*.15}"/>`;
  if(kind==="hills") return `<path ${st} d="M${x-s} ${y+s*.3} Q ${x-s*.5} ${y-s*.5} ${x} ${y+s*.3} Q ${x+s*.5} ${y-s*.5} ${x+s} ${y+s*.3}"/>`;
  if(kind==="forest") return `<path ${st} d="M${x-s*.6} ${y+s*.5} L${x-s*.6} ${y+s*.1} M${x-s*.9} ${y+s*.1} L${x-s*.6} ${y-s*.6} L${x-s*.3} ${y+s*.1} Z"/><path ${st} d="M${x+s*.4} ${y+s*.5} L${x+s*.4} ${y+s*.1} M${x+s*.1} ${y+s*.1} L${x+s*.4} ${y-s*.6} L${x+s*.7} ${y+s*.1} Z"/>`;
  if(kind==="desert") return `<path ${st} d="M${x-s} ${y} Q ${x-s*.5} ${y-s*.5} ${x} ${y} Q ${x+s*.5} ${y+s*.4} ${x+s} ${y}"/>`;
  if(kind==="marsh") return `<path ${st} d="M${x-s} ${y-s*.2} q ${s*.4} ${-s*.3} ${s*.7} 0 q ${s*.4} ${s*.3} ${s*.7} 0"/><path ${st} d="M${x-s*.5} ${y+s*.5} L${x-s*.5} ${y-s*.1} M${x+s*.2} ${y+s*.5} L${x+s*.2} ${y-s*.1}"/>`;
  if(kind==="water") return `<path ${st} d="M${x-s} ${y-s*.3} q ${s*.4} ${-s*.35} ${s*.7} 0 q ${s*.4} ${s*.35} ${s*.7} 0"/><path ${st} d="M${x-s} ${y+s*.25} q ${s*.4} ${-s*.35} ${s*.7} 0 q ${s*.4} ${s*.35} ${s*.7} 0"/>`;
  return `<circle ${st} cx="${x}" cy="${y}" r="${s*.5}"/>`;
}

export function renderMap(){
  if(!activeMapId) activeMapId = S.state.activeMapId || primaryMapId();
  const opts=(S.state.maps||[]).map(m=>'<option value="'+esc(m.id)+'"'+(m.id===activeMapId?" selected":"")+'>'+esc(m.name||m.id)+(m.parent?" ↳":"")+'</option>').join("");
  // The outline/biome click-to-trace tools are RETIRED (locked P2 decision): painting owns land
  // and ground cover. Legacy traced features still render read-only and seed the paint layers.
  // Glyphs are retired with the trace tools: painted elevation replaced their relief meaning,
  // the terrain palette their decorative one. Existing glyph features render read-only.
  // Road is an inline SVG — the 🛤 emoji has spotty font coverage and renders as junk glyphs.
  const ICON_ROAD='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7.5 21 L10 3"/><path d="M16.5 21 L14 3"/><path d="M12 4.5v2.5M12 11v3M12 18v3"/></svg>';
  const tools=[["select","↖","Select"],["lasso","▧","Lasso select"],["marker","📍","Place marker"],["land","🏝","Land brush ( [ ] resizes )"],["terrain","🖌","Terrain brush ( [ ] resizes )"],["elev","⛰","Elevation brush ( [ ] resizes )"],["stamp","🏠","Place asset stamp"],["river","〜","Draw river (drag)"],["road",ICON_ROAD,"Draw road (drag)"],["border","┅","Draw border (drag)"]];
  const sea=activeMap().sea!==false; // ocean by DEFAULT — a map starts as blank sea you paint land into
  const seaY=typeof activeMap().seaLevel==="number"?activeMap().seaLevel:0;
  const elevControls = mapTool!=="elev" ? "" :
    '<select class="sw" id="elev-mode">'+[["raise","Raise"],["lower","Lower"],["smooth","Smooth"],["level","Level"]].map(m=>'<option value="'+m[0]+'"'+(m[0]===elevMode?" selected":"")+'>'+m[1]+'</option>').join("")+'</select>'
    +'<label class="coord" style="margin-left:0">r</label><input type="range" id="elev-radius" min="2" max="200" step="1" value="'+elevRadius+'" style="width:80px" title="Brush radius (m)">'
    +'<label class="coord" style="margin-left:0">str</label><input type="range" id="elev-strength" min="0.05" max="1" step="0.05" value="'+elevStrength+'" style="width:64px" title="Brush strength">'
    +(elevMode==="level"?'<input type="number" id="elev-levely" value="'+elevLevelY+'" step="0.5" style="width:56px" class="sw" title="Level target (m)">':'')
    +'<label class="coord" style="margin-left:0">sea</label><input type="range" id="elev-sea" min="-12" max="12" step="0.5" value="'+seaY+'" style="width:80px" title="Sea level (m)"><span class="coord" id="elev-sea-val" style="margin-left:0">'+seaY+'m</span>';
  const landControls = mapTool!=="land" ? "" :
    '<select class="sw" id="lm-mode">'+[["land","Raise land"],["ocean","Carve ocean"]].map(m=>'<option value="'+m[0]+'"'+(m[0]===lmMode?" selected":"")+'>'+m[1]+'</option>').join("")+'</select>'
    +'<label class="coord" style="margin-left:0">r</label><input type="range" id="lm-radius" min="10" max="400" step="5" value="'+lmRadius+'" style="width:110px" title="Brush radius (m)"><span class="coord" id="lm-radius-val" style="margin-left:0">'+lmRadius+'m</span>';
  const terrainControls = mapTool!=="terrain" ? "" :
    '<select class="sw" id="ter-kind">'+["grass","forest","mountain","desert","tundra","swamp"].map(k=>'<option value="'+k+'"'+(k===terKind?" selected":"")+'>'+k+'</option>').join("")+'<option value="erase"'+(terKind==="erase"?" selected":"")+'>erase</option></select>'
    +'<label class="coord" style="margin-left:0">r</label><input type="range" id="ter-radius" min="8" max="300" step="4" value="'+terRadius+'" style="width:110px" title="Brush radius (m)"><span class="coord" id="ter-radius-val" style="margin-left:0">'+terRadius+'m</span>';
  const colorPick = !["river","road","border"].includes(mapTool) ? "" :
    '<input type="color" id="draw-color" value="'+drawColor+'" title="Line color" style="width:32px;height:28px;border:1px solid var(--line);border-radius:6px;background:none;cursor:pointer">';
  const props = colorPick+elevControls+landControls+terrainControls;
  document.getElementById("center").innerHTML =
    // The svg is REBUILT on every render — it must carry the CURRENT viewBox, not a hardcoded
    // default: syncViewBox caches the container size and early-returns when unchanged, so a
    // hardcoded default here survives every re-render after the first (the recurring
    // letterbox-margin bug).
    '<div class="map-wrap"><div class="map-svg-wrap"><svg class="map" id="map-svg" viewBox="0 0 '+VBW+' '+VBH+'"></svg>'
    +'<div class="fi fi-corner">'
      +'<select class="sw" id="map-sw" title="Switch map">'+opts+'</select>'
      +'<button class="tool" id="map-new" title="New map">＋</button>'
      +'<button class="tool'+(sea?" on":"")+'" id="map-sea" title="Ocean background">🌊</button>'
      +'<button class="tool" id="map-import" title="Import a compiled world map as paint layers"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v11"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/></svg></button>'
      +'<button class="tool" id="map-compile" title="Compile this map to a world asset (buildable + importable)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 21V10"/><path d="M7 14l5-5 5 5"/><path d="M4 3h16"/></svg></button>'
      +(zoneSizeM()!==null?'<input type="number" id="zone-size" class="sw" value="'+zoneSizeM()+'" min="50" step="50" style="width:76px" title="World size in meters (zone.size_m in the World Bible) — compile refuses maps larger than 2x this"><span class="coord">m</span>':'')
      +'<button class="tool" id="map-peek" title="Peek in 3D — compile + render a rotating real-GPU setpiece of this map"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 17l6-8 4 5 3-3 5 6z"/><circle cx="8.5" cy="6.5" r="1.6"/></svg></button>'
      +'<span class="fi-sep"></span>'
      +'<button class="tool" id="map-undo" title="Undo (Ctrl+Z) — session only">↩</button>'
      +'<button class="tool" id="map-redo" title="Redo (Ctrl+Shift+Z)">↪</button>'
    +'</div>'
    +'<div class="fi fi-tools">'+tools.map(t=>'<button class="tool'+(mapTool===t[0]?" on":"")+'" data-tool="'+t[0]+'" title="'+t[2]+'">'+t[1]+'</button>').join("")+'</div>'
    +(props?'<div class="fi fi-props">'+props+'</div>':'')
    +(mapTool!=="stamp"?"":'<div class="fi fi-catalog" id="stamp-catalog">'
      +(catalog===null?'<div class="ci-note">loading catalog…</div>'
        :(catalog.length===0?'<div class="ci-note">catalog is empty</div>'
        :catalog.map(c=>'<button class="cat-item'+(c.id===stampAssetId?" on":"")+'" data-asset="'+esc(c.id)+'" title="'+esc(c.id)+'">'
          +'<img src="/assets/qc/'+esc((c.qcRender||"").split("/").pop())+'" loading="lazy" onerror="this.style.visibility=\'hidden\'">'
          +'<span>'+esc(c.title||c.id)+'</span></button>').join("")))
      +'</div>')
    +'<div class="map-layers" id="map-layers"></div>'
    +'<div class="fi fi-coord" id="map-coord">—</div>'
    +'<div class="map-hint" id="map-hint"></div></div></div>';
  // Fit the view to content only when first opening this map — NOT on every re-render
  // (tool change, sea toggle, edit), so the pan/zoom stays put while you work.
  const marks=mapMarkers();
  if(fittedMap!==activeMapId && marks.length){ const xs=marks.map(l=>l.x),zs=marks.map(l=>l.z);
    mapPan={x:(Math.min(...xs)+Math.max(...xs))/2, z:(Math.min(...zs)+Math.max(...zs))/2};
    const spanX=Math.max(30,Math.max(...xs)-Math.min(...xs)), spanZ=Math.max(30,Math.max(...zs)-Math.min(...zs));
    mapScale=Math.max(1, Math.min((VBW-120)/spanX, (VBH-120)/spanZ)); fittedMap=activeMapId; }
  syncViewBox(); bindMap(); redrawMap();
}
function hint(){ const h=document.getElementById("map-hint"); if(!h) return;
  const t={select:"drag a marker to move · click to edit · drag empty space to pan · scroll to zoom · Ctrl+Z undo (this session)",
    lasso:"drag a box to select features + markers, then delete them",
    elev:"drag anywhere to "+elevMode+" terrain (one stroke = one undo step) · digging below sea level CARVES WATER · [ ] resizes the brush · painting REPLACES glyph/biome relief at build time",
    land:"drag anywhere to "+(lmMode==="ocean"?"carve ocean":"paint land")+" (one stroke = one undo step) · the coastline derives from what you paint · painting REPLACES the traced coast at build time",
    terrain:"drag to paint "+(terKind==="erase"?"(erase ground cover)":terKind)+" (one stroke = one undo step) · ground shows on land only · painting REPLACES drawn biome regions at build time",
    marker:"click the map to place a marker",
    stamp:(stampAssetId?"click to place "+stampAssetId:"pick an asset from the catalog, then click to place")+" · select tool moves stamps · Delete removes",
    river:"drag to draw the river's course (smoothed on release)",
    road:"drag to draw the road (smoothed on release)",
    border:"drag to draw a political border (smoothed on release)",
    outline:"click to trace the coastline (land) · double-click to close · Esc to cancel"}[mapTool];
  h.textContent=t||""; }
function syncUndoButtons(){
  const u=document.getElementById("map-undo"), r=document.getElementById("map-redo");
  if(u){ u.disabled=!history.undo.length; u.style.opacity=history.undo.length?"1":".4"; }
  if(r){ r.disabled=!history.redo.length; r.style.opacity=history.redo.length?"1":".4"; }
}
function redrawMap(){
  const svg=document.getElementById("map-svg"); if(!svg) return;
  let step=10; while(step*mapScale<40) step*=2; while(step*mapScale>140) step/=2;
  // Screen-top is the SMALLER z under north=-z (z grows downward on screen) — iterate zTop→zBot.
  // The old loops ran max→min and silently produced zero horizontal gridlines and zero z ticks.
  const [wx0,wzTop]=s2w(0,0), [wx1,wzBot]=s2w(VBW,VBH);
  let g="";
  for(let x=Math.ceil(wx0/step)*step; x<=wx1; x+=step){ const [sx]=w2s(x,0); g+='<line class="map-grid" x1="'+sx+'" y1="0" x2="'+sx+'" y2="'+VBH+'"/>'; }
  for(let z=Math.ceil(wzTop/step)*step; z<=wzBot; z+=step){ const [,sy]=w2s(0,z); g+='<line class="map-grid" x1="0" y1="'+sy+'" x2="'+VBW+'" y2="'+sy+'"/>'; }
  const [ax]=w2s(0,0),[,ay]=w2s(0,0); g+='<line class="map-axis" x1="'+ax+'" y1="0" x2="'+ax+'" y2="'+VBH+'"/><line class="map-axis" x1="0" y1="'+ay+'" x2="'+VBW+'" y2="'+ay+'"/>';
  // Scale indication: the map's world units convert to real meters via its SCALE CONTRACT
  // (units.unitsPerMeter — 1 for plain engine-meter maps, so behavior is unchanged by default).
  // (a) axis tick labels at every gridline — x values along the bottom edge, z along the left;
  // (b) a zoom-adaptive scale bar (1/2/5×10^n meters, 60-150px) bottom-right, m→km rollover.
  const upm=(activeMap().units&&activeMap().units.unitsPerMeter)||1;
  const fmtM=(v)=>{ const m=v*upm; return Math.abs(m)>=1000?(Math.round(m/100)/10)+"km":Math.round(m)+"m"; };
  for(let x=Math.ceil(wx0/step)*step; x<=wx1; x+=step){ const [sx]=w2s(x,0);
    if(sx>28&&sx<VBW-28) g+='<text class="map-tick" x="'+(sx+3)+'" y="'+(VBH-6)+'">'+fmtM(x)+'</text>'; }
  for(let z=Math.ceil(wzTop/step)*step; z<=wzBot; z+=step){ const [,sy]=w2s(0,z);
    if(sy>16&&sy<VBH-12) g+='<text class="map-tick" x="4" y="'+(sy-3)+'">'+fmtM(z)+'</text>'; }
  let bar=step; while(bar*mapScale<60) bar*=2; while(bar*mapScale>150) bar/=2;
  const bpx=bar*mapScale, bx1=VBW-24-bpx, by=VBH-18;
  g+='<line class="map-scalebar" x1="'+bx1+'" y1="'+by+'" x2="'+(bx1+bpx)+'" y2="'+by+'"/>'
    +'<line class="map-scalebar" x1="'+bx1+'" y1="'+(by-4)+'" x2="'+bx1+'" y2="'+(by+4)+'"/>'
    +'<line class="map-scalebar" x1="'+(bx1+bpx)+'" y1="'+(by-4)+'" x2="'+(bx1+bpx)+'" y2="'+(by+4)+'"/>'
    +'<text class="map-scalebar-label" x="'+(bx1+bpx/2)+'" y="'+(by-8)+'" text-anchor="middle">'+fmtM(bar)+'</text>';
  // features (outline first, then areas, lines, glyphs)
  const feats=curFeatures();
  const poly=(pts)=>pts.map(p=>{const[sx,sy]=w2s(p[0],p[1]);return sx+","+sy;}).join(" ");
  const fsvg=(f)=>{
    if(f.type==="area"){
      if(f.kind==="outline") return '<polygon class="feat" data-fid="'+f.id+'" points="'+poly(f.points)+'" fill="'+(f.fill||"#dccfa6")+'" fill-opacity="0.95" stroke="#b89b6a" stroke-width="3" stroke-linejoin="round"/>';
      const b=f.biome||"grass";
      return '<polygon class="feat" data-fid="'+f.id+'" points="'+poly(f.points)+'" fill="url(#biome-'+b+')" fill-opacity="0.9" stroke="'+(BIOME_BASE[b]||"#888")+'" stroke-opacity=".45" stroke-width="1" stroke-linejoin="round"/>'; }
    if(f.type==="line"){
      if(f.kind==="border") return '<polyline class="feat" data-fid="'+f.id+'" points="'+poly(f.points)+'" fill="none" stroke="'+(f.color||"#b23838")+'" stroke-width="2.4" stroke-dasharray="8 4" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>';
      const road=f.kind==="road";
      return '<polyline class="feat" data-fid="'+f.id+'" points="'+poly(f.points)+'" fill="none" stroke="'+(f.color||(road?"#8a6f4a":"#5b7d9a"))+'" stroke-width="'+(road?2:2.4)+'"'+(road?' stroke-dasharray="6 5"':'')+' stroke-linejoin="round" stroke-linecap="round"/>'; }
    if(f.type==="glyph"){ const [sx,sy]=w2s(f.x,f.z); return '<g class="feat glyphf" data-fid="'+f.id+'">'+glyphSVG(f.glyph||"mountain",sx,sy,16)+'</g>'; }
    return ""; };
  const ocean=activeMap().sea!==false ? '<rect x="0" y="0" width="'+VBW+'" height="'+VBH+'" fill="url(#biome-water)"/>' : '';
  // Painted landmass (Painter P1): the land image blits over the mask rect (soft alpha shore),
  // the coastline polygon on top is derived by the SAME marching-squares code the compiler runs.
  // While a mask with land exists, hand-traced outline features are hidden — the compiler
  // ignores them (precedence), so showing both would draw a coast the build won't have.
  let landLayer="", coastLayer="", maskHasLand=false;
  {
    const em=activeMap();
    const lm=LM.landmassOf(em.id) || (em.rasters&&em.rasters.landmass ? LM.ensureLandmass(em) : null);
    if(lm){
      const eff=currentEff(em, lm);
      const coast=LM.coastPolygons(lm, em.id, eff);
      maskHasLand=coast.length>0;
      if(!hiddenLayers.has("landmass")){
        const [lx,ly]=w2s(lm.rect.x0,lm.rect.z0);
        landLayer='<image id="land-img" href="'+LM.renderLandImage(lm, em.id, eff)+'" x="'+lx+'" y="'+ly+'" width="'+(lm.rect.w*mapScale)+'" height="'+(lm.rect.h*mapScale)+'" preserveAspectRatio="none" style="pointer-events:none"/>';
        coastLayer=coast.map(p=>'<polygon points="'+poly(p.points)+'" fill="none" stroke="'+LM.coastStroke+'" stroke-width="2.5" stroke-linejoin="round" opacity=".9" style="pointer-events:none"/>').join("");
      }
    }
  }
  // Painted biome ground cover (Painter P2): textured, dithered, alpha-clipped to the landmass.
  // While the raster has content, legacy hand-traced biome polygons are hidden (the compiler
  // ignores them — showing both would draw ground the build won't have).
  let terrainLayer="", bioHasContent=false;
  {
    const em=activeMap();
    const bio=LM.biomesOf(em.id) || (em.rasters&&em.rasters.biomes ? LM.ensureBiomes(em) : null);
    if(bio){
      bioHasContent=LM.biomesHaveContent(bio);
      if(bioHasContent&&!hiddenLayers.has("biomes")){
        const lm2=LM.landmassOf(em.id);
        const [bx,by]=w2s(bio.rect.x0,bio.rect.z0);
        terrainLayer='<image id="terrain-img" href="'+LM.renderBiomesImage(bio, em.id, (lm2&&currentEff(em,lm2))||lm2)+'" x="'+bx+'" y="'+by+'" width="'+(bio.rect.w*mapScale)+'" height="'+(bio.rect.h*mapScale)+'" preserveAspectRatio="none" style="pointer-events:none"/>';
      }
    }
  }
  // Painted elevation hillshade: rendered between the land fill and the semantic layers, so
  // relief reads as the terrain base while biomes/lines/pins stay legible on top. The raster is
  // only CREATED by an actual brush stroke (never by merely selecting the tool — creation flips
  // build-time precedence away from glyph/biome relief hints, so it must be an explicit act).
  let elevLayer="";
  if(!hiddenLayers.has("elevation")){
    const em=activeMap();
    const e=EL.elevationOf(em.id) || (em.rasters&&em.rasters.elevation ? EL.ensureElevation(em, mapMarkers()) : null);
    if(e){
      const seaY=typeof em.seaLevel==="number"?em.seaLevel:0;
      const key=em.id+":"+seaY+":"+elevRev;
      if(elevShadeFor!==key){ elevShadeUrl=EL.renderHillshade(e, seaY); elevShadeFor=key; }
      const [ex,ey]=w2s(e.rect.x0,e.rect.z0);
      elevLayer='<image id="elev-img" href="'+elevShadeUrl+'" x="'+ex+'" y="'+ey+'" width="'+(e.rect.w*mapScale)+'" height="'+(e.rect.h*mapScale)+'" preserveAspectRatio="none" opacity="0.8" style="pointer-events:none"/>';
    }
  }
  const outlines=maskHasLand ? "" : feats.filter(f=>f.type==="area"&&f.kind==="outline").map(fsvg).join("");
  const areas=bioHasContent ? "" : feats.filter(f=>f.type==="area"&&f.kind!=="outline").map(fsvg).join("");
  const lines=feats.filter(f=>f.type==="line"&&f.kind!=="border").map(fsvg).join("");
  const borders=feats.filter(f=>f.type==="line"&&f.kind==="border").map(fsvg).join("");
  const glyphs=feats.filter(f=>f.type==="glyph").map(fsvg).join("");
  // Placed asset stamps (P3): each draws its QC render at TRUE world footprint (catalog
  // boundsM x scale), rotatable; a dangling assetId draws a LOUD placeholder, never nothing.
  if((activeMap().stamps||[]).length>0 && catalog===null) loadCatalog();
  const byId=catalogById();
  const stampPx=(s)=>{ const c=byId.get(s.assetId); const wm=(c&&c.boundsM?Math.max(c.boundsM[0],c.boundsM[2]):16)*(s.scale||1); return Math.max(14,wm*mapScale); };
  const stampsLayer=hiddenLayers.has("stamps")?"":(activeMap().stamps||[]).map(s=>{
    const [sx,sy]=w2s(s.x,s.z);
    const c=byId.get(s.assetId);
    const px=stampPx(s);
    const rot=s.rot?(' transform="rotate('+(s.rot*180/Math.PI).toFixed(1)+' '+sx+' '+sy+')"'):'';
    const sel=s.id===selStamp?'<circle cx="'+sx+'" cy="'+sy+'" r="'+(px/2+5)+'" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-dasharray="5 4" style="pointer-events:none"/>':'';
    if(!c&&catalog!==null) return '<g class="stampf" data-sid="'+s.id+'"'+rot+'><rect x="'+(sx-9)+'" y="'+(sy-9)+'" width="18" height="18" fill="#b96a2b" opacity=".9" rx="4"/><text x="'+(sx+13)+'" y="'+(sy+4)+'" font-size="11" fill="#b96a2b">⚠ '+esc(s.assetId)+'</text>'+sel+'</g>';
    if(!c) return "";
    return '<g class="stampf" data-sid="'+s.id+'"'+rot+'><image href="/assets/qc/'+esc((c.qcRender||"").split("/").pop())+'" x="'+(sx-px/2)+'" y="'+(sy-px/2)+'" width="'+px+'" height="'+px+'" preserveAspectRatio="xMidYMid slice"/>'+sel+'</g>';
  }).join("");
  // Ghost preview of the armed stamp under the cursor.
  let stampGhost="";
  if(mapTool==="stamp"&&stampAssetId){
    const c=byId.get(stampAssetId);
    const gpx=Math.max(14,((c&&c.boundsM?Math.max(c.boundsM[0],c.boundsM[2]):16))*mapScale);
    stampGhost=c?'<image id="stamp-ghost" data-px="'+gpx+'" href="/assets/qc/'+esc((c.qcRender||"").split("/").pop())+'" width="'+gpx+'" height="'+gpx+'" opacity="0" preserveAspectRatio="xMidYMid slice" style="pointer-events:none"/>':"";
  }
  // in-progress drawing
  let draw="";
  if(drawPts.length){ const isArea=["area","outline"].includes(mapTool); const pp=poly(drawPts);
    draw=(isArea?'<polygon points="'+pp+'" fill="'+drawColor+'" fill-opacity="0.2" stroke="'+drawColor+'" stroke-dasharray="4 4" stroke-width="1.4"/>':'<polyline points="'+pp+'" fill="none" stroke="'+drawColor+'" stroke-dasharray="4 4" stroke-width="2"/>')
      +drawPts.map(p=>{const[sx,sy]=w2s(p[0],p[1]);return '<circle cx="'+sx+'" cy="'+sy+'" r="3" fill="'+drawColor+'"/>';}).join(""); }
  // markers
  const pins=mapMarkers().map(l=>{ const [sx,sy]=w2s(l.x,l.z); const c=KIND_FILL[l.kind]||"#2f6f7a";
    return '<g class="pin" data-id="'+l.id+'" transform="translate('+sx+','+sy+')">'
      +(l.mapLink?'<circle r="12" fill="none" stroke="'+c+'" stroke-dasharray="2 2" opacity=".7"/>':'')
      +'<circle r="7" fill="'+c+'"/><text x="11" y="4">'+esc(l.name)+(l.mapLink?' ⤢':'')+'</text></g>'; }).join("");
  const compass='<g transform="translate('+(VBW-44)+',44)"><circle r="18" fill="var(--panel)" stroke="var(--line)"/><text class="compass" x="0" y="-6" text-anchor="middle">N</text><line class="map-axis" x1="0" y1="10" x2="0" y2="-2" stroke="var(--muted)"/></g>';
  const elevCursor = (mapTool==="elev"||mapTool==="land"||mapTool==="terrain") ? '<circle id="elev-cursor" r="'+((mapTool==="land"?lmRadius:mapTool==="terrain"?terRadius:elevRadius)*mapScale)+'" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0" style="pointer-events:none"/>' : '';
  // No visible paint-region chrome: the raster's world rect is INTERNAL bookkeeping (it maps
  // cells to meters and auto-grows under the brush) — the whole canvas is the editor. The old
  // dashed region + handles predates invisible-unpainted rendering and auto-grow; both reasons
  // for user-managed extent are gone.
  svg.innerHTML = biomeDefs() + ocean + landLayer + terrainLayer + g + coastLayer + outlines + elevLayer + areas + lines + borders + glyphs + stampsLayer + draw + pins + compass + elevCursor + stampGhost;
  renderLayers(); syncUndoButtons();
  svg.querySelectorAll(".pin").forEach(p=>{ p.addEventListener("mousedown",(e)=>startPinDrag(e,p.dataset.id)); p.addEventListener("dblclick",(e)=>{e.stopPropagation(); const loc=mapMarkers().find(l=>l.id===p.dataset.id); if(loc&&loc.mapLink) switchMap(loc.mapLink);}); });
  svg.querySelectorAll(".stampf").forEach(el=>{
    el.style.cursor = mapTool==="select" ? "move" : "";
    el.addEventListener("mousedown",(e)=>{ if(mapTool!=="select") return; e.stopPropagation();
      const sid=el.dataset.sid; selStamp=sid; selFeat=null;
      const s=(activeMap().stamps||[]).find(x=>x.id===sid); if(!s) return;
      mapDrag={type:"stampmove",sid,start:{x:s.x,z:s.z,rot:s.rot,scale:s.scale},moved:false};
      redrawMap(); });
  });
  if(mapTool==="select") bindFeatureEditing(svg);
  hint();
}
function featLabel(f){
  if(f.type==="area") return f.kind==="outline"?"Coast (land)":((f.biome||"biome")+" region");
  if(f.type==="line") return f.kind==="border"?"Border":f.kind==="road"?"Road":"River";
  if(f.type==="glyph") return (f.glyph||"glyph")+" glyph";
  return f.type; }
function featSwatch(f){
  if(f.type==="area") return f.kind==="outline"?"#dccfa6":(BIOME_BASE[f.biome]||"#8a8a86");
  if(f.type==="line") return f.kind==="border"?"#b23838":f.kind==="road"?"#8a6f4a":(f.color||"#5b7d9a");
  return "#6b6459"; }
function renderLayers(){
  const el=document.getElementById("map-layers"); if(!el) return;
  const m=activeMap();
  const f=curFeatures();
  // Painted layers are first-class: visible in the panel, deletable (undoable) — a stuck
  // hillshade slab with no way to remove it was the P1-UAT complaint.
  const paints=[];
  if((m.rasters&&m.rasters.landmass)||LM.landmassOf(m.id)) paints.push(["landmass","Landmass (painted)","#dccfa6"]);
  if((m.rasters&&m.rasters.biomes)||LM.biomesOf(m.id)) paints.push(["biomes","Terrain (painted)","#4a7a45"]);
  if((m.rasters&&m.rasters.elevation)||EL.elevationOf(m.id)) paints.push(["elevation","Elevation (painted)","#8fae7a"]);
  if((m.stamps||[]).length>0) paints.push(["stamps","Stamps ("+m.stamps.length+")","#a25151"]);
  // Always name the active map — landing on an empty child map with a bare canvas and no
  // label reads as data loss (it happened).
  el.className="map-layers";
  if(!f.length&&!paints.length){
    el.innerHTML='<div class="lh"><b>'+esc(m.name||m.id)+'</b></div><div class="lr"><span class="nm" style="color:var(--muted)">empty map — paint or stamp to begin</span></div>';
    return;
  }
  el.innerHTML='<div class="lh"><b>'+esc(m.name||m.id)+' ('+(f.length+paints.length)+')</b>'+(f.length?'<button class="clr" id="lyr-clear">Clear features</button>':'')+'</div>'
    +paints.map(p=>{
      // currentColor SVG eye — the 👁 emoji is a dark glyph and vanishes on the dark theme.
      const eyeOn='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>';
      const eyeOff='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" opacity=".45"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';
      return '<div class="lr"><span class="sw" style="background:'+p[2]+'"></span><span class="nm">'+p[1]+'</span>'
      +'<button class="eye'+(hiddenLayers.has(p[0])?" off":"")+'" data-eye="'+p[0]+'" title="Show / hide this layer (view only)">'+(hiddenLayers.has(p[0])?eyeOff:eyeOn)+'</button>'
      +(p[0]==="stamps"?"":'<button class="x" data-paint="'+p[0]+'" title="Delete this painted layer (undoable)">×</button>')+'</div>';}).join("")
    +(f.length>12
      // Imported maps carry hundreds of rivers/roads — group per kind instead of 500 rows.
      ? Object.entries(f.reduce((acc,x)=>{ const k=featLabel(x); (acc[k]=acc[k]||[]).push(x.id); return acc; },{}))
          .map(([label,ids])=>'<div class="lr"><span class="sw" style="background:'+featSwatch(f.find(x=>featLabel(x)===label))+'"></span><span class="nm">'+esc(label)+' ('+ids.length+')</span><button class="x" data-group="'+esc(label)+'" title="Delete all '+esc(label)+' features (undoable)">×</button></div>').join("")
      : f.map((x,i)=>'<div class="lr'+(x.id===selFeat?" sel":"")+'" data-i="'+i+'"><span class="sw" style="background:'+featSwatch(x)+'"></span><span class="nm">'+esc(featLabel(x))+'</span><button class="x" data-i="'+i+'" title="Delete this feature">×</button></div>').join(""));
  const clr=document.getElementById("lyr-clear"); if(clr) clr.onclick=clearMapFeatures;
  el.querySelectorAll(".lr .eye[data-eye]").forEach(b=>b.onclick=(e)=>{ e.stopPropagation();
    const k=b.dataset.eye;
    if(hiddenLayers.has(k)) hiddenLayers.delete(k); else hiddenLayers.add(k);
    redrawMap(); });
  el.querySelectorAll(".lr .x[data-paint]").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); deletePaintLayer(b.dataset.paint); });
  el.querySelectorAll(".lr .x[data-i]").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); deleteFeatById(curFeatures()[+b.dataset.i].id,false); });
  el.querySelectorAll(".lr .x[data-group]").forEach(b=>b.onclick=(e)=>{ e.stopPropagation();
    const label=b.dataset.group;
    const ids=curFeatures().filter(x=>featLabel(x)===label).map(x=>x.id);
    if(!confirm("Delete all "+ids.length+" "+label+" features? (Ctrl+Z restores)")) return;
    commit(H.cmdDeleteFeatures(activeMapId, activeMap(), ids)); });
  el.querySelectorAll(".lr[data-i]").forEach(r=>{ r.onclick=()=>{ mapTool="select"; selFeat=curFeatures()[+r.dataset.i].id; renderMap(); };
    r.onmouseenter=()=>hlFeat(+r.dataset.i,true); r.onmouseleave=()=>hlFeat(+r.dataset.i,false); });
}
/** Delete a painted layer (landmass/elevation) as ONE undoable command. Dirty caches sync into
 *  the doc first so undo restores the user's LATEST paint, then the cache drops so the display
 *  reflects the doc immediately. */
function deletePaintLayer(key){
  const m=activeMap();
  if(!confirm("Delete the painted "+(key==="biomes"?"terrain":key)+" layer? (Ctrl+Z restores it)")) return;
  EL.syncElevationIntoDoc(S.state.maps); LM.syncLandmassIntoDoc(S.state.maps); LM.syncBiomesIntoDoc(S.state.maps);
  const cmd=H.cmdSetRasterLayer(activeMapId, m, key, undefined);
  if(key==="landmass") LM.dropLandmassCache(m.id);
  else if(key==="biomes") LM.dropBiomesCache(m.id);
  else EL.dropElevationCache(m.id);
  elevRev++;
  commit(cmd);
}
/** After undo/redo of a raster-layer command the doc is authoritative: a CLEAN cache whose doc
 *  raster is gone must drop (redo of delete), and a missing cache re-decodes from the restored
 *  doc on the next redraw (undo of delete). Dirty caches (mid-stroke state) are never touched. */
function reconcilePaintCaches(mapId){
  const m=resolveMap(mapId); if(!m) return;
  const doc=m.rasters||{};
  const lm=LM.landmassOf(mapId); if(lm&&!lm.dirty&&!doc.landmass) LM.dropLandmassCache(mapId);
  const bio=LM.biomesOf(mapId); if(bio&&!bio.dirty&&!doc.biomes) LM.dropBiomesCache(mapId);
  const ev=EL.elevationOf(mapId); if(ev&&!ev.dirty&&!doc.elevation) EL.dropElevationCache(mapId);
}
function hlFeat(i,on){ const f=curFeatures()[i]; if(!f) return; const svg=document.getElementById("map-svg"); if(!svg) return;
  const el=svg.querySelector('[data-fid="'+f.id+'"]'); if(el) el.style.filter=on?"drop-shadow(0 0 5px var(--accent))":""; }
function clearMapFeatures(){ if(!curFeatures().length) return;
  if(!confirm("Clear all "+curFeatures().length+" drawn feature(s) on this map? (Markers are not affected.)")) return;
  commit(H.cmdClearFeatures(activeMapId, activeMap())); }

function bindFeatureEditing(svg){
  svg.querySelectorAll(".feat").forEach(el=>{
    const featId=el.dataset.fid; if(featId===selFeat) el.classList.add("selected"); el.style.cursor="pointer";
    el.addEventListener("mousedown",(e)=>{ if(e.button!==0) return; e.stopPropagation();
      if(selFeat!==featId){ selFeat=featId; redrawMap(); return; }
      const f=curFeatures().find(x=>x.id===featId); if(!f) return; const [mx,my]=evtVB(e,svg);
      mapDrag={type:"featmove",fid:featId,mx0:mx,my0:my, start: f.type==="glyph"?{x:f.x,z:f.z}:{points:f.points.map(p=>p.slice())}}; });
    el.addEventListener("contextmenu",(e)=>{ e.preventDefault(); e.stopPropagation(); selFeat=featId; redrawMap(); showFeatMenu(featId,e.clientX,e.clientY); });
  });
  if(selFeat){ const f=curFeatures().find(x=>x.id===selFeat);
    if(!f){ selFeat=null; return; }
    const gg=document.createElementNS(SVGNS,"g"); gg.setAttribute("id","feat-handles");
    const addH=(x,z,idx)=>{ const [sx,sy]=w2s(x,z); const c=document.createElementNS(SVGNS,"circle");
      c.setAttribute("cx",sx); c.setAttribute("cy",sy); c.setAttribute("r",5); c.setAttribute("class","fhandle");
      c.addEventListener("mousedown",(e)=>{ e.stopPropagation(); const [mx,my]=evtVB(e,svg);
        // Capture the pre-drag geometry so mouseup can commit ONE undoable move command.
        const start = f.type==="glyph"?{x:f.x,z:f.z}:{points:f.points.map(p=>p.slice())};
        mapDrag={type:"vertex",fid:selFeat,idx,mx,my,start}; });
      gg.appendChild(c); };
    if(f.type==="glyph") addH(f.x,f.z,-1); else (f.points||[]).forEach((p,i)=>addH(p[0],p[1],i));
    svg.appendChild(gg);
  }
}
function deleteFeatById(featId,confirmFirst){
  const f=curFeatures().find(x=>x.id===featId); if(!f) return;
  if(confirmFirst && !confirm("Delete this "+featLabel(f)+"?")) return;
  selFeat=null;
  commit(H.cmdDeleteFeature(activeMapId, activeMap(), featId));
}
function showFeatMenu(featId,cx,cy){
  document.getElementById("feat-menu")?.remove();
  const m=document.createElement("div"); m.className="ctx-menu"; m.id="feat-menu";
  m.innerHTML='<div class="ci" data-a="props">Properties…</div><div class="ci danger" data-a="del">Delete</div>';
  m.style.left=Math.min(cx,innerWidth-172)+"px"; m.style.top=Math.min(cy,innerHeight-90)+"px";
  document.body.appendChild(m);
  m.querySelector('[data-a="props"]').onclick=()=>{ m.remove(); const f=curFeatures().find(x=>x.id===featId); if(f) openFeatInspector(f,cx,cy); };
  m.querySelector('[data-a="del"]').onclick=()=>{ m.remove(); deleteFeatById(featId,false); };
  // Only OUTSIDE mousedowns close the menu — removing it on an inside mousedown kills the click.
  setTimeout(()=>document.addEventListener("mousedown",function h(ev){ if(m.contains(ev.target)) return; m.remove(); document.removeEventListener("mousedown",h); }),0);
}
function openFeatInspector(f,cx,cy){
  document.getElementById("insp")?.remove();
  let fields="";
  if(f.type==="area"&&f.kind!=="outline") fields='<label>Biome</label><select id="fi-biome">'+BIOME_LIST.map(b=>'<option'+(b===f.biome?" selected":"")+'>'+b+'</option>').join("")+'</select>';
  else if(f.type==="area") fields='<label>Land color</label><input type="color" id="fi-color" value="'+(f.fill||"#dccfa6")+'">';
  else if(f.type==="line") fields='<label>Type</label><select id="fi-kind"><option'+(f.kind==="river"?" selected":"")+'>river</option><option'+(f.kind==="road"?" selected":"")+'>road</option><option'+(f.kind==="border"?" selected":"")+'>border</option></select><label>Color</label><input type="color" id="fi-color" value="'+(f.color||"#5b7d9a")+'">';
  else if(f.type==="glyph") fields='<label>Glyph</label><select id="fi-glyph">'+GLYPHS.map(g=>'<option'+(g===f.glyph?" selected":"")+'>'+g+'</option>').join("")+'</select>';
  const el=document.createElement("div"); el.className="insp"; el.id="insp";
  el.innerHTML='<h4>'+esc(featLabel(f))+'<button class="x" id="insp-x">×</button></h4>'+fields
    +'<div class="actions"><button class="save" id="fi-save">Save</button><button class="del" id="fi-del">Delete</button></div>';
  document.body.appendChild(el);
  const w=el.offsetWidth,h=el.offsetHeight; el.style.left=Math.min((cx||200)+8,innerWidth-w-12)+"px"; el.style.top=Math.min(Math.max((cy||120)-10,12),innerHeight-h-12)+"px"; el.style.right="auto";
  document.getElementById("insp-x").onclick=()=>el.remove();
  document.getElementById("fi-save").onclick=()=>{
    const patch={};
    if(f.type==="area"&&f.kind!=="outline") patch.biome=document.getElementById("fi-biome").value;
    else if(f.type==="area") patch.fill=document.getElementById("fi-color").value;
    else if(f.type==="line"){ patch.kind=document.getElementById("fi-kind").value; patch.color=document.getElementById("fi-color").value; }
    else if(f.type==="glyph") patch.glyph=document.getElementById("fi-glyph").value;
    el.remove();
    commit(H.cmdUpdateFeature(activeMapId, activeMap(), f.id, patch)); };
  document.getElementById("fi-del").onclick=()=>{ el.remove(); deleteFeatById(f.id,false); };
}

function bindMap(){
  const svg=document.getElementById("map-svg"); if(!svg) return;
  svg.addEventListener("contextmenu",(e)=>e.preventDefault());
  document.getElementById("map-sw").onchange=(e)=>switchMap(e.target.value);
  document.getElementById("map-new").onclick=newMap;
  document.getElementById("map-undo").onclick=doUndo;
  document.getElementById("map-redo").onclick=doRedo;
  document.querySelectorAll(".fi-tools .tool[data-tool]").forEach(b=>b.onclick=()=>{ mapTool=b.dataset.tool; drawPts=[]; renderMap(); });
  const dc=document.getElementById("draw-color"); if(dc) dc.oninput=(e)=>{ drawColor=e.target.value; redrawMap(); };
  const seaBtn=document.getElementById("map-sea"); if(seaBtn) seaBtn.onclick=()=>{
    const m=activeMap();
    commit(H.cmdSetMapProp(activeMapId,"sea",m.sea,!(m.sea!==false)));
    renderMap(); };
  const imp=document.getElementById("map-import"); if(imp) imp.onclick=showImportMenu;
  const pk=document.getElementById("map-peek"); if(pk) pk.onclick=doPeek;
  const cmp=document.getElementById("map-compile"); if(cmp) cmp.onclick=()=>doCompile(false);
  const zs=document.getElementById("zone-size"); if(zs) zs.onchange=async(e)=>{
    const v=Number(e.target.value);
    if(!(v>=50)){ e.target.value=zoneSizeM(); return; }
    if(await setZoneSizeM(v)) toast("world size → "+Math.round(v)+"m (World Bible updated)");
  };
  document.querySelectorAll("#stamp-catalog .cat-item").forEach(b=>b.onclick=()=>{ stampAssetId=b.dataset.asset; renderMap(); });
  if(mapTool==="stamp"&&catalog===null) loadCatalog();
  const tk=document.getElementById("ter-kind"); if(tk) tk.onchange=(e)=>{ terKind=e.target.value; hint(); };
  const tr2=document.getElementById("ter-radius"); if(tr2) tr2.oninput=(e)=>{ terRadius=Number(e.target.value);
    const lab=document.getElementById("ter-radius-val"); if(lab) lab.textContent=terRadius+"m";
    const c=document.getElementById("elev-cursor"); if(c) c.setAttribute("r",terRadius*mapScale); };
  const lmm=document.getElementById("lm-mode"); if(lmm) lmm.onchange=(e)=>{ lmMode=e.target.value; hint(); };
  const lmr=document.getElementById("lm-radius"); if(lmr) lmr.oninput=(e)=>{ lmRadius=Number(e.target.value);
    const lab=document.getElementById("lm-radius-val"); if(lab) lab.textContent=lmRadius+"m";
    const c=document.getElementById("elev-cursor"); if(c) c.setAttribute("r",lmRadius*mapScale); };
  const em1=document.getElementById("elev-mode"); if(em1) em1.onchange=(e)=>{ elevMode=e.target.value; renderMap(); };
  const er1=document.getElementById("elev-radius"); if(er1) er1.oninput=(e)=>{ elevRadius=Number(e.target.value); const c=document.getElementById("elev-cursor"); if(c) c.setAttribute("r",elevRadius*mapScale); };
  const es1=document.getElementById("elev-strength"); if(es1) es1.oninput=(e)=>{ elevStrength=Number(e.target.value); };
  const el1=document.getElementById("elev-levely"); if(el1) el1.onchange=(e)=>{ elevLevelY=Number(e.target.value)||0; };
  const sea1=document.getElementById("elev-sea"); if(sea1){
    const seaBefore=typeof activeMap().seaLevel==="number"?activeMap().seaLevel:0;
    sea1.oninput=(e)=>{ const v=Number(e.target.value); activeMap().seaLevel=v; const lab=document.getElementById("elev-sea-val"); if(lab) lab.textContent=v+"m"; elevRev++; refreshElevImage(); refreshLandImage(); };
    // Commit ONE undoable step per slider release (the live oninput preview already applied it).
    sea1.onchange=(e)=>{ const v=Number(e.target.value); if(v!==seaBefore) commit(H.cmdSetMapProp(activeMapId,"seaLevel",seaBefore,v),{applied:true}); };
  }
  svg.addEventListener("wheel",(e)=>{ e.preventDefault(); const [mx,my]=evtVB(e,svg); const [wx,wz]=s2w(mx,my);
    // Min zoom 0.05 (was 0.4): a km-scale map (FMG import / continental coast) must be able to
    // fit the viewport — at 0.4 a 2.6km island could never be seen whole, so its elevation
    // region's edges were unreachable.
    mapScale*=e.deltaY<0?1.12:1/1.12; mapScale=Math.max(.05,Math.min(80,mapScale));
    // Keep the world point under the cursor fixed: sy = 320+(z-panz)*scale, so BOTH axes correct
    // with += (a -= on z was a leftover mirror from the +z=north era — it made zoom drift and
    // pan feel inverted vertically after the north=-z convention fix).
    const [nx,ny]=w2s(wx,wz); mapPan.x+=(nx-mx)/mapScale; mapPan.z+=(ny-my)/mapScale; redrawMap(); },{passive:false});
  svg.addEventListener("mousedown",(e)=>{ if(mapDrag) return; if(e.detail>=2) return; const [mx,my]=evtVB(e,svg); const [x,z]=s2w(mx,my);
    if(spaceDown||e.button===1){ mapDrag={type:"pan",mx,my,px:mapPan.x,pz:mapPan.z}; svg.classList.add("grabbing"); return; }
    if(mapTool==="elev"){
      const em=activeMap();
      const created=!EL.hasStoredElevation(em);
      const er=EL.ensureElevation(em, mapMarkers());
      if(created) redrawMap(); // first stroke: the hillshade layer appears under the cursor
      mapDrag={type:"elev",mapId:activeMapId,raster:er,before:er.cells.slice(),bbox:null,lastW:[x,z]};
      elevDab(er,x,z,mapDrag); return; }
    if(mapTool==="land"){
      const em=activeMap();
      let lm=LM.landmassOf(em.id)||LM.ensureLandmass(em);
      let created=false;
      if(!lm){ lm=LM.createLandmass(em, mapMarkers()); created=true; }
      // First stroke = ONE command carrying the whole grid: `before` is the EMPTY mask, so the
      // outline seed rasterized by createLandmass undoes together with the stroke (the doc
      // returns to pure-vector precedence — no un-commanded mutation survives).
      const before=created?new Uint8Array(lm.w*lm.h):lm.cells.slice();
      mapDrag={type:"land",mapId:activeMapId,raster:lm,before,
        bbox:created?{c0:0,r0:0,c1:lm.w-1,r1:lm.h-1}:null,lastW:[x,z]};
      landDabAt(lm,x,z,mapDrag);
      if(created) redrawMap(); // the land layer appears under the cursor
      return; }
    if(mapTool==="terrain"){
      const em=activeMap();
      let bio=LM.biomesOf(em.id)||LM.ensureBiomes(em);
      let created=false;
      if(!bio){ bio=LM.createBiomes(em, mapMarkers()); created=true; }
      // First stroke bundles the legacy-vector-biome seed (Convert-to-paint) exactly like the
      // landmass: `before` is the EMPTY grid, so one undo returns the doc to vector precedence.
      const before=created?new Uint8Array(bio.w*bio.h):bio.cells.slice();
      mapDrag={type:"terrain",mapId:activeMapId,raster:bio,before,
        bbox:created?{c0:0,r0:0,c1:bio.w-1,r1:bio.h-1}:null,lastW:[x,z]};
      terDabAt(bio,x,z,mapDrag);
      if(created) redrawMap();
      return; }
    if(mapTool==="marker"){ openInspector(null,{x:Math.round(x),z:Math.round(z)},e.clientX,e.clientY); return; }
    if(mapTool==="stamp"){
      if(!stampAssetId){ toast("pick an asset from the catalog"); return; }
      commit(H.cmdAddStamp(activeMapId,{id:fid(),assetId:stampAssetId,x:Math.round(x),z:Math.round(z)}));
      return; }
    if(["river","road","border"].includes(mapTool)){
      // Drag-stroke drawing (P3): the line follows the drag, Chaikin-smoothed on commit.
      mapDrag={type:"draw",kind:mapTool,pts:[[Math.round(x),Math.round(z)]],lastW:[x,z]};
      drawPts=mapDrag.pts; return; }
    if(mapTool==="lasso"){ mapDrag={type:"lasso",x0:mx,y0:my,x1:mx,y1:my}; return; }
    if(mapTool==="select"&&selFeat){ selFeat=null; redrawMap(); }
    mapDrag={type:"pan",mx,my,px:mapPan.x,pz:mapPan.z}; svg.classList.add("grabbing"); });
  window.addEventListener("mousemove",onMapMove); window.addEventListener("mouseup",onMapUp);
  svg.addEventListener("mousemove",(e)=>{ const [mx,my]=evtVB(e,svg); const [wx,wz]=s2w(mx,my);
    const c=document.getElementById("map-coord");
    if(c){ const er=EL.elevationOf(activeMap().id);
      c.textContent="x "+Math.round(wx)+"  z "+Math.round(wz)+(er?"  y "+EL.sampleY(er,wx,wz).toFixed(1)+"m":""); }
    const cur=document.getElementById("elev-cursor");
    if(cur){ cur.setAttribute("cx",mx); cur.setAttribute("cy",my); cur.setAttribute("opacity","0.9"); }
    const gh=document.getElementById("stamp-ghost");
    if(gh){ const px=+gh.dataset.px; gh.setAttribute("x",mx-px/2); gh.setAttribute("y",my-px/2); gh.setAttribute("opacity","0.55"); } });
  window.addEventListener("keydown",mapKey); window.addEventListener("keyup",mapKeyUp);
  // Keep the 1:1 viewBox in lockstep with the container (window resize, panel collapse).
  if(vbObserver) vbObserver.disconnect();
  vbObserver=new ResizeObserver(()=>{ if(syncViewBox()) redrawMap(); });
  const wrap=document.querySelector(".map-svg-wrap"); if(wrap) vbObserver.observe(wrap);
}
let vbObserver=null;
function mapKey(e){ if(S.activeView!=="map") return;
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement||{}).tagName||"");
  // No key-repeat undo: a held Ctrl+Z fires ~30/s and silently walks past raster strokes into
  // deleting features added hours earlier. One press = one step.
  if((e.ctrlKey||e.metaKey)&&!typing&&(e.key==="z"||e.key==="Z")){ e.preventDefault(); if(e.repeat) return; if(e.shiftKey) doRedo(); else doUndo(); return; }
  if((e.ctrlKey||e.metaKey)&&!typing&&(e.key==="y"||e.key==="Y")){ e.preventDefault(); if(e.repeat) return; doRedo(); return; }
  // Photoshop-style brush sizing: [ shrinks, ] grows the ACTIVE brush (~12% steps).
  if((e.key==="["||e.key==="]")&&!typing&&["land","terrain","elev"].includes(mapTool)){
    e.preventDefault();
    const dir=e.key==="]"?1:-1;
    const bump=(v,min,max)=>Math.max(min,Math.min(max,Math.round(v+dir*Math.max(1,v*0.12))));
    if(mapTool==="land") lmRadius=bump(lmRadius,10,400);
    else if(mapTool==="terrain") terRadius=bump(terRadius,8,300);
    else elevRadius=bump(elevRadius,2,200);
    syncBrushUI(); return;
  }
  if((e.key===" "||e.code==="Space")&&!typing){ if(!spaceDown){ spaceDown=true; document.getElementById("map-svg")?.classList.add("space"); } e.preventDefault(); return; }
  if(e.key==="Escape"){ drawPts=[]; selFeat=null; selStamp=null; document.getElementById("feat-menu")?.remove(); redrawMap(); }
  else if((e.key==="Delete"||e.key==="Backspace")&&(selFeat||selStamp)&&!typing){ e.preventDefault();
    if(selStamp){ commit(H.cmdDeleteStamp(activeMapId, activeMap(), selStamp)); selStamp=null; }
    else deleteFeatById(selFeat,true); } }
function mapKeyUp(e){ if(e.key===" "||e.code==="Space"){ spaceDown=false; document.getElementById("map-svg")?.classList.remove("space"); } }
/** Reflect a keyboard brush-size change in the props island (slider + label) and the cursor. */
function syncBrushUI(){
  const r = mapTool==="land"?lmRadius:mapTool==="terrain"?terRadius:elevRadius;
  const slider = document.getElementById(mapTool==="land"?"lm-radius":mapTool==="terrain"?"ter-radius":"elev-radius");
  if(slider) slider.value=String(r);
  const lab = document.getElementById(mapTool==="land"?"lm-radius-val":mapTool==="terrain"?"ter-radius-val":null);
  if(lab) lab.textContent=r+"m";
  const c=document.getElementById("elev-cursor"); if(c) c.setAttribute("r",r*mapScale);
}
// Open-polyline Chaikin (endpoints pinned) + min-distance decimation — drag-drawn rivers/roads
// commit as smooth, bounded-vertex lines.
function chaikinOpen(pts){
  if(pts.length<3) return pts;
  const out=[pts[0]];
  for(let i=0;i<pts.length-1;i++){
    const [x1,z1]=pts[i],[x2,z2]=pts[i+1];
    out.push([x1*.75+x2*.25,z1*.75+z2*.25],[x1*.25+x2*.75,z1*.25+z2*.75]);
  }
  out.push(pts[pts.length-1]);
  return out;
}
function decimatePts(pts,minD){
  if(pts.length<3) return pts;
  const out=[pts[0]];
  for(let i=1;i<pts.length-1;i++){
    const l=out[out.length-1];
    if(Math.hypot(pts[i][0]-l[0],pts[i][1]-l[1])>=minD) out.push(pts[i]);
  }
  out.push(pts[pts.length-1]);
  return out;
}
/** Compile the active map to a world asset. On a scale-contract refusal, offer to grow the
 *  declared world size to fit and retry ONCE — assisted, never silent. */
async function doCompile(retried){
  await flushMapSave(); // compile what's on disk = what you see
  let msg="";
  try{
    const j=await postJSON("/api/compile-map",{mapId:activeMapId});
    if(!j.error){
      toast("compiled → "+j.file+((j.warnings||[]).length?" ("+j.warnings.length+" warnings)":""), 4500);
      return;
    }
    msg=String(j.error);
  }catch(e){ msg=String(e); }
  const mm=/bbox ([\d.]+)x([\d.]+)m exceeds 2x world-bible zone\.size_m=([\d.]+)m/.exec(msg);
  if(mm&&!retried){
    const span=Math.max(Number(mm[1]),Number(mm[2]));
    const need=Math.ceil(span*1.1/100)*100;
    if(confirm("The map is ~"+Math.round(span)+"m across but the world is declared "+mm[3]+"m.\nGrow the world to "+need+"m (updates the World Bible) and compile again?")){
      if(await setZoneSizeM(need)){ renderMap(); return doCompile(true); }
    }
    return;
  }
  toast("compile failed: "+msg, 6000);
}

// ── 3D peek (P5): compile + render one real-GPU frame of this map, shown in a lightbox ──────
let peekPoll=null;
async function doPeek(){
  if(!confirm("Render a 3D peek of this map? (~30–90s)\n\n⚠ If the limina 3D EDITOR is open in a browser tab, close it first — a headless GPU render beside it can crash its graphics context.")) return;
  await flushMapSave();
  let j;
  try{ j=await postJSON("/api/peek",{mapId:activeMapId}); }
  catch(e){ toast("peek failed: "+String(e), 6000); return; }
  if(j.error){ toast("peek failed: "+j.error, 6000); return; }
  if(j.editorHostUp) toast("rendering… note: the editor host is running — if its browser tab is open, the render may destabilize it", 6000);
  else toast("rendering 3D peek… (30–90s)", 5000);
  if(peekPoll) clearInterval(peekPoll);
  peekPoll=setInterval(async()=>{
    try{
      const s=await (await fetch("/api/peek/"+j.job)).json();
      if(s.status==="done"){ clearInterval(peekPoll); peekPoll=null; showPeek(s.frameUrls&&s.frameUrls.length?s.frameUrls:[s.url]); }
      else if(s.status==="error"||s.status==="unknown"){ clearInterval(peekPoll); peekPoll=null; toast("peek failed: "+(s.error||s.status), 7000); }
    }catch{ /* keep polling */ }
  }, 2500);
}
// Rotating setpiece: the job pre-renders evenly-spaced yaw frames of the auto-spinning orbit;
// cycle them (preloaded) so the peek reads as a turntable, not a single oddball still.
function showPeek(urls){
  document.getElementById("peek-box")?.remove();
  const t=Date.now();
  const imgs=urls.map(u=>{ const im=new Image(); im.src=u+"?t="+t; return im; });
  const d=document.createElement("div"); d.id="peek-box";
  d.style.cssText="position:fixed;inset:0;background:rgba(12,11,9,.75);display:flex;align-items:center;justify-content:center;z-index:60;cursor:zoom-out";
  const img=document.createElement("img");
  img.src=imgs[0].src;
  img.style.cssText="max-width:92%;max-height:92%;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.55)";
  img.alt="3D peek render";
  d.appendChild(img);
  let k=0, spin=null;
  if(imgs.length>1) spin=setInterval(()=>{ k=(k+1)%imgs.length; if(imgs[k].complete) img.src=imgs[k].src; }, 220);
  d.onclick=()=>{ if(spin) clearInterval(spin); d.remove(); };
  document.body.appendChild(d);
}

// ── WorldMap IR import (P4): compiled/FMG maps become editable paint layers ─────────────────
async function showImportMenu(){
  let files=[];
  try{ files=await (await fetch("/api/worldmaps")).json(); }catch{ /* fall through */ }
  if(!files.length){ toast("no compiled world maps found (assets/maps/*.worldmap.json)"); return; }
  document.getElementById("feat-menu")?.remove();
  const m=document.createElement("div"); m.className="ctx-menu"; m.id="feat-menu";
  m.innerHTML=files.map(f=>'<div class="ci" data-f="'+esc(f)+'">'+esc(f)+'</div>').join("");
  const btn=document.getElementById("map-import").getBoundingClientRect();
  m.style.left=btn.left+"px"; m.style.top=(btn.bottom+6)+"px";
  document.body.appendChild(m);
  // Bind on mousedown with stopPropagation: the close-on-outside-mousedown handler below would
  // otherwise remove the menu BEFORE a click event can fire on the item (mousedown bubbles to
  // document first, the element leaves the DOM, and the click never dispatches).
  m.querySelectorAll(".ci").forEach(d=>d.addEventListener("mousedown",(e)=>{ e.stopPropagation(); m.remove(); importWorldMap(d.dataset.f); }));
  setTimeout(()=>document.addEventListener("mousedown",function h(ev){ if(m.contains(ev.target)) return; m.remove(); document.removeEventListener("mousedown",h); }),0);
}
async function importWorldMap(file){
  if(!confirm('Import "'+file+'" into this map? Painted layers and stamps will be REPLACED (Ctrl+Z restores).')) return;
  let wm;
  try{ wm=await (await fetch("/api/worldmaps/"+encodeURIComponent(file))).json(); }
  catch{ toast("failed to load "+file); return; }
  let after;
  try{ after=LM.importWorldMapIntoLayers(wm); }
  catch(e){ toast(String(e.message||e)); return; }
  const em=activeMap();
  EL.dropElevationCache(em.id); LM.dropLandmassCache(em.id); LM.dropBiomesCache(em.id);
  selStamp=null; elevRev++;
  commit(H.cmdImportLayers(activeMapId, em, after));
  // Fit the view to the imported extent.
  mapPan={x:after.rect.x0+after.rect.w/2, z:after.rect.z0+after.rect.h/2};
  mapScale=Math.max(0.05, Math.min((VBW-140)/after.rect.w, (VBH-140)/after.rect.h));
  renderMap();
  toast("imported "+file);
}
/** ELEVATION CARVES WATER: the effective land mask for display = painted land minus painted
 *  sub-sea elevation (see map-paint.effectiveLand — the compiler applies the identical rule).
 *  Null when the map has no painted elevation. */
function currentEff(em, lm){
  const er=EL.elevationOf(em.id) || (em.rasters&&em.rasters.elevation ? EL.ensureElevation(em, mapMarkers()) : null);
  if(!er) return null;
  const seaY=typeof em.seaLevel==="number"?em.seaLevel:0;
  return LM.effectiveLand(lm, em.id, er, seaY, elevRev);
}
// ── landmass stroke helpers (Painter P1) ─────────────────────────────────────────────────────
function landDabAt(lm,wx,wz,drag){
  // The extent is never a wall: a dab outside it grows the raster mid-stroke, co-resampling
  // the stroke's undo snapshot so undo stays exact; the bbox widens to the full grid.
  if(LM.growRasterToInclude(lm,wx,wz,lmRadius,0,[drag.before])){
    drag.bbox={c0:0,r0:0,c1:lm.w-1,r1:lm.h-1};
    redrawMap();
  }
  const bb=LM.landDab(lm,wx,wz,{mode:lmMode,radiusM:lmRadius});
  if(bb){
    drag.bbox = drag.bbox
      ? {c0:Math.min(drag.bbox.c0,bb.c0),r0:Math.min(drag.bbox.r0,bb.r0),c1:Math.max(drag.bbox.c1,bb.c1),r1:Math.max(drag.bbox.r1,bb.r1)}
      : bb;
    refreshLandImage();
  }
}
function terDabAt(bio,wx,wz,drag){
  if(LM.growRasterToInclude(bio,wx,wz,terRadius,0,[drag.before])){
    drag.bbox={c0:0,r0:0,c1:bio.w-1,r1:bio.h-1};
    redrawMap();
  }
  const value=terKind==="erase"?0:(LM.BIOME_CLASSES.indexOf(terKind)+1);
  const bb=LM.biomeDab(bio,wx,wz,{value,radiusM:terRadius});
  if(bb){
    drag.bbox = drag.bbox
      ? {c0:Math.min(drag.bbox.c0,bb.c0),r0:Math.min(drag.bbox.r0,bb.r0),c1:Math.max(drag.bbox.c1,bb.c1),r1:Math.max(drag.bbox.r1,bb.r1)}
      : bb;
    refreshTerrainImage();
  }
}
let terRafPending=false;
function refreshTerrainImage(){
  if(terRafPending) return; terRafPending=true;
  requestAnimationFrame(()=>{ terRafPending=false;
    const em=activeMap(); const bio=LM.biomesOf(em.id); if(!bio) return;
    const img=document.getElementById("terrain-img");
    const lm=LM.landmassOf(em.id);
    if(img) img.setAttribute("href",LM.renderBiomesImage(bio, em.id, (lm&&currentEff(em,lm))||lm)); else redrawMap();
  });
}
let landRafPending=false;
function refreshLandImage(){
  // During a stroke only the soft mask-alpha image updates per frame; the marching-squares
  // coastline recomputes at stroke end (commit -> redrawMap), keeping dabs cheap.
  if(landRafPending) return; landRafPending=true;
  requestAnimationFrame(()=>{ landRafPending=false;
    const em=activeMap(); const lm=LM.landmassOf(em.id); if(!lm) return;
    const img=document.getElementById("land-img");
    if(img) img.setAttribute("href",LM.renderLandImage(lm, em.id, currentEff(em, lm))); else redrawMap();
  });
}
// ── elevation stroke helpers ─────────────────────────────────────────────────────────────────
function elevDab(er,wx,wz,drag){
  // Same never-a-wall contract as landmass; new cells fill with the flat-y=0 value so growth
  // never digs pits at the old edge.
  const flat=Math.round((0-er.minY)/(er.maxY-er.minY)*255);
  if(LM.growRasterToInclude(er,wx,wz,elevRadius,flat,[drag.before])){
    drag.bbox={c0:0,r0:0,c1:er.w-1,r1:er.h-1};
    elevRev++; redrawMap();
  }
  const bb=EL.brushDab(er,wx,wz,{mode:elevMode,radiusM:elevRadius,strength:elevStrength,levelY:elevLevelY});
  if(bb){
    drag.bbox = drag.bbox
      ? {c0:Math.min(drag.bbox.c0,bb.c0),r0:Math.min(drag.bbox.r0,bb.r0),c1:Math.max(drag.bbox.c1,bb.c1),r1:Math.max(drag.bbox.r1,bb.r1)}
      : bb;
    elevRev++; refreshElevImage();
    refreshLandImage(); // digging below sea level carves water — the land layer follows live
  }
}
let elevRafPending=false;
function refreshElevImage(){
  if(elevRafPending) return; elevRafPending=true;
  requestAnimationFrame(()=>{ elevRafPending=false;
    const em=activeMap(); const er=EL.elevationOf(em.id); if(!er) return;
    const seaY=typeof em.seaLevel==="number"?em.seaLevel:0;
    elevShadeUrl=EL.renderHillshade(er,seaY); elevShadeFor=em.id+":"+seaY+":"+elevRev;
    const img=document.getElementById("elev-img");
    if(img) img.setAttribute("href",elevShadeUrl); else redrawMap();
  });
}
function startPinDrag(e,id){ if(mapTool!=="select"){ return; } e.stopPropagation(); const svg=document.getElementById("map-svg"); const [mx,my]=evtVB(e,svg); mapDrag={type:"pin",id,mx,my,sx:mx,sy:my,moved:false,cx:e.clientX,cy:e.clientY}; svg.querySelector('.pin[data-id="'+id+'"]').classList.add("drag"); }
function onMapMove(e){ if(!mapDrag) return; const svg=document.getElementById("map-svg"); if(!svg) return; const [mx,my]=evtVB(e,svg);
  if(mapDrag.type==="pan"){ mapPan.x=mapDrag.px-(mx-mapDrag.mx)/mapScale; mapPan.z=mapDrag.pz-(my-mapDrag.my)/mapScale; redrawMap(); }
  else if(mapDrag.type==="elev"){
    // Interpolate dabs between the last and current pointer position so fast strokes stay solid.
    const [wx,wz]=s2w(mx,my); const [lx,lz]=mapDrag.lastW;
    const dist=Math.hypot(wx-lx,wz-lz), stepM=Math.max(1,elevRadius/3);
    const steps=Math.max(1,Math.ceil(dist/stepM));
    for(let k=1;k<=steps;k++) elevDab(mapDrag.raster, lx+(wx-lx)*k/steps, lz+(wz-lz)*k/steps, mapDrag);
    mapDrag.lastW=[wx,wz]; }
  else if(mapDrag.type==="land"){
    const [wx,wz]=s2w(mx,my); const [lx,lz]=mapDrag.lastW;
    const dist=Math.hypot(wx-lx,wz-lz), stepM=Math.max(2,lmRadius/3);
    const steps=Math.max(1,Math.ceil(dist/stepM));
    for(let k=1;k<=steps;k++) landDabAt(mapDrag.raster, lx+(wx-lx)*k/steps, lz+(wz-lz)*k/steps, mapDrag);
    mapDrag.lastW=[wx,wz]; }
  else if(mapDrag.type==="terrain"){
    const [wx,wz]=s2w(mx,my); const [lx,lz]=mapDrag.lastW;
    const dist=Math.hypot(wx-lx,wz-lz), stepM=Math.max(2,terRadius/3);
    const steps=Math.max(1,Math.ceil(dist/stepM));
    for(let k=1;k<=steps;k++) terDabAt(mapDrag.raster, lx+(wx-lx)*k/steps, lz+(wz-lz)*k/steps, mapDrag);
    mapDrag.lastW=[wx,wz]; }
  else if(mapDrag.type==="draw"){
    const [wx,wz]=s2w(mx,my); const [lx,lz]=mapDrag.lastW;
    if(Math.hypot(wx-lx,wz-lz)>=4/mapScale){
      mapDrag.pts.push([Math.round(wx),Math.round(wz)]); mapDrag.lastW=[wx,wz];
      drawPts=mapDrag.pts; redrawMap();
    } }
  else if(mapDrag.type==="stampmove"){
    const s=(activeMap().stamps||[]).find(x=>x.id===mapDrag.sid);
    if(s){ const [wx,wz]=s2w(mx,my); s.x=Math.round(wx); s.z=Math.round(wz); mapDrag.moved=true; redrawMap(); } }
  else if(mapDrag.type==="lasso"){ mapDrag.x1=mx; mapDrag.y1=my; drawLassoRect(svg); }
  else if(mapDrag.type==="vertex"){ const f=curFeatures().find(x=>x.id===mapDrag.fid); if(f){ const [wx,wz]=s2w(mx,my); if(mapDrag.idx<0){ f.x=Math.round(wx); f.z=Math.round(wz); } else if(f.points){ f.points[mapDrag.idx]=[Math.round(wx),Math.round(wz)]; } redrawMap(); } }
  else if(mapDrag.type==="featmove"){ const f=curFeatures().find(x=>x.id===mapDrag.fid); if(f){ const [wx,wz]=s2w(mx,my),[wx0,wz0]=s2w(mapDrag.mx0,mapDrag.my0); const dx=Math.round(wx-wx0),dz=Math.round(wz-wz0); if(f.type==="glyph"){ f.x=mapDrag.start.x+dx; f.z=mapDrag.start.z+dz; } else { f.points=mapDrag.start.points.map(p=>[p[0]+dx,p[1]+dz]); } redrawMap(); } }
  else { if(Math.abs(mx-mapDrag.sx)+Math.abs(my-mapDrag.sy)>5) mapDrag.moved=true; const p=svg.querySelector('.pin[data-id="'+mapDrag.id+'"]'); if(p) p.setAttribute("transform","translate("+mx+","+my+")"); } }
function drawLassoRect(svg){ const d=mapDrag; let r=document.getElementById("lasso-rect");
  if(!r){ r=document.createElementNS(SVGNS,"rect"); r.id="lasso-rect"; r.setAttribute("class","lasso-rect"); svg.appendChild(r); }
  r.setAttribute("x",Math.min(d.x0,d.x1)); r.setAttribute("y",Math.min(d.y0,d.y1)); r.setAttribute("width",Math.abs(d.x1-d.x0)); r.setAttribute("height",Math.abs(d.y1-d.y0)); }
function inBox(wx,wz,box){ return wx>=box.minX&&wx<=box.maxX&&wz>=box.minZ&&wz<=box.maxZ; }
async function finishLasso(d){
  document.getElementById("lasso-rect")?.remove();
  if(Math.abs(d.x1-d.x0)<4&&Math.abs(d.y1-d.y0)<4) return;
  const [ax,az]=s2w(d.x0,d.y0), [bx,bz]=s2w(d.x1,d.y1);
  const box={minX:Math.min(ax,bx),maxX:Math.max(ax,bx),minZ:Math.min(az,bz),maxZ:Math.max(az,bz)};
  const feats=curFeatures().filter(f=> f.type==="glyph" ? inBox(f.x,f.z,box) : (f.points||[]).some(p=>inBox(p[0],p[1],box)));
  const marks=mapMarkers().filter(l=>inBox(l.x,l.z,box));
  if(!feats.length&&!marks.length) return;
  const linked=marks.filter(l=>l.mapLink);
  let msg="Delete "+feats.length+" map feature(s) and unlink "+marks.length+" marker(s) from this map?\n(Markers are removed from the map, not deleted from the design — no cascade.)";
  if(linked.length) msg="⚠ "+linked.map(l=>l.name+" → map '"+l.mapLink+"'").join(", ")+"\nThose links will be removed (the linked maps are kept).\n\n"+msg;
  if(!confirm(msg)) return;
  if(feats.length) commit(H.cmdDeleteFeatures(activeMapId, activeMap(), feats.map(f=>f.id)));
  await flushMapSave();
  if(marks.length){ try{ await postJSON("/api/edit-location",{op:"unlink",ids:marks.map(l=>l.id)}); }catch(e){} }
  await S.fn.reload(); renderMap();
}
async function onMapUp(e){ if(!mapDrag) return; const svg=document.getElementById("map-svg"); if(svg) svg.classList.remove("grabbing"); const d=mapDrag; mapDrag=null;
  if(d.type==="lasso"){ finishLasso(d); return; }
  if(d.type==="draw"){
    drawPts=[];
    let pts=d.pts;
    if(pts.length>=2){
      pts=decimatePts(chaikinOpen(chaikinOpen(pts)), Math.max(2,4/mapScale));
      commit(H.cmdAddFeature(activeMapId,{id:fid(),type:"line",kind:d.kind,points:pts.map(p=>[Math.round(p[0]),Math.round(p[1])]),color:drawColor}));
    } else redrawMap();
    return; }
  if(d.type==="stampmove"){
    const s=(activeMap().stamps||[]).find(x=>x.id===d.sid);
    if(s&&d.moved) commit(H.cmdMoveStamp(activeMapId,d.sid,d.start,{x:s.x,z:s.z,rot:s.rot,scale:s.scale}),{applied:true});
    else redrawMap();
    return; }
  if(d.type==="elev"||d.type==="land"||d.type==="terrain"){
    // One stroke = one undo step: bbox slices of the pre-stroke snapshot vs the current cells.
    if(d.bbox){
      const beforeRaster={w:d.raster.w,h:d.raster.h,cells:d.before};
      const before=H.rasterBboxSnapshot(beforeRaster,d.bbox);
      const after=H.rasterBboxSnapshot(d.raster,d.bbox);
      const label=d.type==="land"?"landmass stroke":d.type==="terrain"?"terrain stroke":"elevation stroke";
      commit(H.cmdPatchRaster(d.mapId,d.raster,d.bbox,before,after,label),{applied:true});
    }
    return; }
  if(d.type==="vertex"||d.type==="featmove"){
    // Drag-commit: geometry mutated live during the gesture; push ONE already-applied command
    // capturing start -> end so the whole drag is a single undo step.
    const f=curFeatures().find(x=>x.id===d.fid);
    if(f&&d.start){ const after = f.type==="glyph"?{x:f.x,z:f.z}:{points:f.points.map(p=>p.slice())};
      if(JSON.stringify(after)!==JSON.stringify(d.start))
        commit(H.cmdMoveFeature(activeMapId,d.fid,d.start,after),{applied:true}); }
    return; }
  if(d.type!=="pin") return;
  if(!d.moved){ redrawMap(); const loc=mapMarkers().find(l=>l.id===d.id); if(loc) openInspector(loc,null,d.cx,d.cy); return; }
  const [mx,my]=evtVB(e,svg); const [wx,wz]=s2w(mx,my);
  try{ const j=await postJSON("/api/edit-location",{op:"move",id:d.id,x:wx,z:wz}); await S.fn.reload(); renderMap(); if(j.impacts&&j.impacts.length) S.fn.surfaceCascade(j.impacts); }catch(err){ redrawMap(); } }

async function switchMap(id){ activeMapId=id; S.state.activeMapId=id; drawPts=[]; selFeat=null; await flushMapSave(); renderMap(); }
async function newMap(){ const name=prompt("Name the new map (e.g. The Marches, or a city name):"); if(!name) return;
  const id=name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||("map"+(S.state.maps.length+1));
  if(S.state.maps.some(m=>m.id===id)){ alert("a map with that id exists"); return; }
  S.state.maps.push({id,name,scope:"region",parent:activeMapId,sea:true,features:[],units:{kind:"m",unitsPerMeter:1,origin:[0,0]}}); await flushMapSave(); switchMap(id); }

// ---- marker inspector: create / edit / tag / link / delete (spawns at the mouse) ----
function openInspector(marker, pos, cx, cy){
  const old=document.getElementById("insp"); if(old) old.remove();
  const isNew=!marker;
  const m = marker || { name:"", kind:"landmark", region:((S.state.world.regions||[])[0]||{}).id||"", tags:[], x:pos.x, z:pos.z, mapLink:"" };
  const regions = S.state.world.regions||[];
  const otherMaps=(S.state.maps||[]).filter(mp=>mp.id!==activeMapId);
  const el=document.createElement("div"); el.className="insp"; el.id="insp";
  el.innerHTML='<h4>'+(isNew?"New marker":"Edit marker")+'<button class="x" id="insp-x">×</button></h4>'
    +'<label>Name</label><input id="i-name" value="'+esc(m.name)+'">'
    +'<div class="row"><div><label>Kind</label><select id="i-kind">'+KINDS.map(k=>'<option'+(k===m.kind?" selected":"")+'>'+k+'</option>').join("")+'</select></div>'
    +'<div><label>Region</label><select id="i-region">'+regions.map(r=>'<option value="'+esc(r.id)+'"'+(r.id===m.region?" selected":"")+'>'+esc(r.name)+'</option>').join("")+'</select></div></div>'
    +'<label>Tags (comma-separated)</label><input id="i-tags" value="'+esc((m.tags||[]).join(", "))+'">'
    +'<label>Links to map (zoom in)</label><select id="i-link"><option value="">— none —</option>'+otherMaps.map(mp=>'<option value="'+esc(mp.id)+'"'+(mp.id===m.mapLink?" selected":"")+'>'+esc(mp.name||mp.id)+'</option>').join("")+'</select>'
    +'<div class="co">x '+Math.round(m.x)+'  z '+Math.round(m.z)+(isNew?"  · placed":"")+'</div>'
    +'<div class="actions"><button class="save" id="insp-save">'+(isNew?"Create marker":"Save")+'</button>'
    +(isNew?"":'<button class="del" id="insp-unlink">Off map</button><button class="del" id="insp-del">Delete</button>')+'</div>';
  document.body.appendChild(el);
  if(typeof cx==="number"){ const w=el.offsetWidth,h=el.offsetHeight; el.style.left=Math.min(cx+14, innerWidth-w-12)+"px"; el.style.top=Math.min(Math.max(cy-20,12), innerHeight-h-12)+"px"; el.style.right="auto"; }
  document.getElementById("insp-x").onclick=()=>el.remove();
  document.getElementById("insp-save").onclick=()=>saveMarker(isNew?null:m.id, {x:m.x,z:m.z});
  const del=document.getElementById("insp-del"); if(del) del.onclick=()=>deleteMarker(m.id);
  const unl=document.getElementById("insp-unlink"); if(unl) unl.onclick=()=>unlinkMarker(m.id);
  document.getElementById("i-name").focus();
}
async function unlinkMarker(id){
  try{ await postJSON("/api/edit-location",{op:"unlink",ids:[id]});
    document.getElementById("insp")?.remove(); await S.fn.reload(); renderMap();
  }catch(e){} }
async function saveMarker(id, pos){
  const name=document.getElementById("i-name").value.trim();
  const kind=document.getElementById("i-kind").value, region=document.getElementById("i-region").value;
  const tags=document.getElementById("i-tags").value.split(",").map(s=>s.trim()).filter(Boolean);
  const mapLink=document.getElementById("i-link").value;
  if(!name){ document.getElementById("i-name").focus(); return; }
  const body = id ? {op:"update",id,name,kind,region,tags,mapLink} : {op:"add",name,kind,region,tags,mapLink,x:pos.x,z:pos.z,map:(activeMapId!==primaryMapId()?activeMapId:"")};
  const btn=document.getElementById("insp-save"); btn.disabled=true; btn.textContent="Saving…";
  try{ const j=await postJSON("/api/edit-location",body);
    document.getElementById("insp")?.remove(); await S.fn.reload(); renderMap();
    if(j.impacts&&j.impacts.length) S.fn.surfaceCascade(j.impacts);
  }catch(e){ btn.disabled=false; btn.textContent="Save"; } }
async function deleteMarker(id){
  const loc=(S.state.world.locations||[]).find(l=>l.id===id);
  let warn="Delete '"+(loc?loc.name:id)+"' from the design? This cascades to anything that references it.";
  if(loc&&loc.mapLink) warn="⚠ This marker links to map '"+loc.mapLink+"'. Deleting removes the marker (the linked map is kept).\n\n"+warn;
  if(!confirm(warn)) return;
  try{ const j=await postJSON("/api/edit-location",{op:"delete",id});
    document.getElementById("insp")?.remove(); await S.fn.reload(); renderMap();
    if(j.impacts&&j.impacts.length) S.fn.surfaceCascade(j.impacts);
  }catch(e){} }
