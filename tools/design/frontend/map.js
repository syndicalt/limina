// map.js — the Map Studio view: 2D cartography over multiple hierarchical maps (world -> region ->
// city). Rendering + interaction only; the doc shape is owned by tools/design/map-doc.mjs, and
// EVERY cartography mutation goes through the pure command stack in map-commands.js so it is
// undoable (Ctrl+Z / Ctrl+Shift+Z, session-memory only). Markers are NOT commands: they live in
// the world-bible and flow through /api/edit-location with its own cascade surfacing.
//
// COORDINATE CONVENTION: north = -z, east = +x (right-handed, matches THREE's -z-forward default).
// North draws UP on screen, so screen-y grows as z grows: w2s's z term is `320 + (z-panz)*scale`
// (a `-` there is the old, mirrored +z=north convention that shipped a bug).

import { esc } from "./util.js";
import { S } from "./store.js";
import { postJSON, bindMapSaver, scheduleMapSave, flushMapSave } from "./net.js";
import * as H from "./map-commands.js";
import * as EL from "./map-elevation.js";

const KIND_FILL = { civic:"#3f7d57", dwelling:"#8a6f4a", religious:"#6d5f7a", military:"#a25151", marker:"#b9772b",
  settlement:"#3f7d57", landmark:"#2f6f7a", camp:"#b9772b", ruin:"#a25151", dungeon:"#6d5f7a", wild:"#7a8a6a" };
const KINDS = ["civic","dwelling","religious","military","marker","landmark","camp","ruin","wild"];
const GLYPHS = ["mountain","hills","forest","desert","marsh","water","peak"];
const GLYPH_LABEL = { mountain:"⛰ Mountains", hills:"⌒ Hills", forest:"♣ Forest", desert:"≈ Desert", marsh:"⍦ Marsh", water:"≋ Water", peak:"▲ Peak" };
const BIOME_LIST = ["grass","forest","mountain","desert","tundra","swamp","water"];
const BIOME_BASE = { grass:"#8aa85f", forest:"#4a7a45", mountain:"#8f8d88", desert:"#d9c48f", tundra:"#dbe4ea", swamp:"#6b7a55", water:"#3f6ea5" };
const SVGNS = "http://www.w3.org/2000/svg";

let mapPan={x:0,z:0}, mapScale=6, mapDrag=null, mapTool="select", glyphKind="mountain", biomeKind="forest",
  drawColor="#5b7d9a", drawPts=[], activeMapId=null, selFeat=null, spaceDown=false, fittedMap=null;
// Elevation brush state (S1). A stroke = one undo step: full-buffer snapshot at stroke start,
// bbox-union of every dab, ONE cmdPatchRaster pushed {applied:true} at stroke end.
let elevMode="raise", elevRadius=12, elevStrength=0.6, elevLevelY=4;
let elevShadeUrl=null, elevShadeFor=null; // cached hillshade data-URL + "mapId:seaLevel:rev" key
let elevRev=0; // bumped on every raster mutation (stroke dab, undo, redo)
let uid = Math.floor(1e6*(''+performance.now()).length);
const fid = () => "f" + (uid++);

// One history for the whole session; each command carries its mapId (undo on map A while viewing
// map B resolves A by id and still applies).
const history = H.createHistory(100);
const resolveMap = (id) => (S.state.maps || []).find((m) => m.id === id) || null;
function commit(cmd, opts) {
  if (!cmd) return;
  H.push(history, cmd, opts, resolveMap(cmd.mapId));
  scheduleMapSave(); redrawMap();
}
function doUndo() { if (H.undo(history, resolveMap)) { selFeat = null; elevRev++; scheduleMapSave(); redrawMap(); } }
function doRedo() { if (H.redo(history, resolveMap)) { selFeat = null; elevRev++; scheduleMapSave(); redrawMap(); } }

// Dirty rasters serialize into the doc at save-payload time (stroke-end debounce), never per dab.
bindMapSaver(() => { EL.syncElevationIntoDoc(S.state.maps); return { maps: S.state.maps, activeMapId }; });

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

function w2s(x,z){ return [500 + (x-mapPan.x)*mapScale, 320 + (z-mapPan.z)*mapScale]; }
function s2w(sx,sy){ return [mapPan.x + (sx-500)/mapScale, mapPan.z + (sy-320)/mapScale]; }
function evtVB(e,svg){
  // Map client px -> viewBox coords via the SVG's own transform, so it stays exact regardless of
  // the letterboxing preserveAspectRatio adds when the element's aspect ratio differs from the
  // viewBox (1000:640). A naive rect-ratio mapping drifts.
  const m=svg.getScreenCTM();
  if(m){ const p=svg.createSVGPoint(); p.x=e.clientX; p.y=e.clientY; const q=p.matrixTransform(m.inverse()); return [q.x,q.y]; }
  const r=svg.getBoundingClientRect(); return [(e.clientX-r.left)/r.width*1000, (e.clientY-r.top)/r.height*640];
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
  const tools=[["select","Select"],["lasso","Lasso"],["marker","＋ Marker"],["elev","⛰ Elevation"],["glyph","Glyph"],["area","Biome"],["river","River"],["road","Road"],["border","Border"],["outline","Coast"]];
  const sea=!!activeMap().sea;
  const seaY=typeof activeMap().seaLevel==="number"?activeMap().seaLevel:0;
  const elevControls = mapTool!=="elev" ? "" :
    '<select class="sw" id="elev-mode">'+[["raise","Raise"],["lower","Lower"],["smooth","Smooth"],["level","Level"]].map(m=>'<option value="'+m[0]+'"'+(m[0]===elevMode?" selected":"")+'>'+m[1]+'</option>').join("")+'</select>'
    +'<label class="coord" style="margin-left:0">r</label><input type="range" id="elev-radius" min="2" max="200" step="1" value="'+elevRadius+'" style="width:80px" title="Brush radius (m)">'
    +'<label class="coord" style="margin-left:0">str</label><input type="range" id="elev-strength" min="0.05" max="1" step="0.05" value="'+elevStrength+'" style="width:64px" title="Brush strength">'
    +(elevMode==="level"?'<input type="number" id="elev-levely" value="'+elevLevelY+'" step="0.5" style="width:56px" class="sw" title="Level target (m)">':'')
    +'<label class="coord" style="margin-left:0">sea</label><input type="range" id="elev-sea" min="-12" max="12" step="0.5" value="'+seaY+'" style="width:80px" title="Sea level (m)"><span class="coord" id="elev-sea-val" style="margin-left:0">'+seaY+'m</span>';
  document.getElementById("center").innerHTML =
    '<div class="map-wrap"><div class="map-head">'
    +'<select class="sw" id="map-sw">'+opts+'</select><button class="tool" id="map-new">＋ New map</button>'
    +'<button class="tool'+(sea?" on":"")+'" id="map-sea" title="Ocean background">🌊 Sea</button>'
    +'<span style="width:1px;height:22px;background:var(--line)"></span>'
    +'<button class="tool" id="map-undo" title="Undo (Ctrl+Z) — session only">↩</button>'
    +'<button class="tool" id="map-redo" title="Redo (Ctrl+Shift+Z)">↪</button>'
    +'<span style="width:1px;height:22px;background:var(--line)"></span>'
    +tools.map(t=>'<button class="tool'+(mapTool===t[0]?" on":"")+'" data-tool="'+t[0]+'">'+t[1]+'</button>').join("")
    +'<select class="sw" id="glyph-pick" style="'+(mapTool==="glyph"?"":"display:none")+'">'+GLYPHS.map(g=>'<option value="'+g+'"'+(g===glyphKind?" selected":"")+'>'+GLYPH_LABEL[g]+'</option>').join("")+'</select>'
    +'<select class="sw" id="biome-pick" style="'+(mapTool==="area"?"":"display:none")+'">'+BIOME_LIST.map(b=>'<option value="'+b+'"'+(b===biomeKind?" selected":"")+'>'+b+'</option>').join("")+'</select>'
    +'<input type="color" id="draw-color" value="'+drawColor+'" title="Line / coast color" style="'+(["outline","river","road","border"].includes(mapTool)?"":"display:none")+'; width:32px;height:28px;border:1px solid var(--line);border-radius:6px;background:none;cursor:pointer">'
    +elevControls
    +'<span class="coord" id="map-coord">—</span></div>'
    +'<div class="map-svg-wrap"><svg class="map" id="map-svg" viewBox="0 0 1000 640"></svg>'
    +'<div class="map-layers" id="map-layers"></div>'
    +'<div class="map-hint" id="map-hint"></div></div></div>';
  // Fit the view to content only when first opening this map — NOT on every re-render
  // (tool change, sea toggle, edit), so the pan/zoom stays put while you work.
  const marks=mapMarkers();
  if(fittedMap!==activeMapId && marks.length){ const xs=marks.map(l=>l.x),zs=marks.map(l=>l.z);
    mapPan={x:(Math.min(...xs)+Math.max(...xs))/2, z:(Math.min(...zs)+Math.max(...zs))/2};
    const spanX=Math.max(30,Math.max(...xs)-Math.min(...xs)), spanZ=Math.max(30,Math.max(...zs)-Math.min(...zs));
    mapScale=Math.max(1, Math.min(880/spanX, 520/spanZ)); fittedMap=activeMapId; }
  bindMap(); redrawMap();
}
function hint(){ const h=document.getElementById("map-hint"); if(!h) return;
  const t={select:"drag a marker to move · click to edit · drag empty space to pan · scroll to zoom · Ctrl+Z undo (this session)",
    lasso:"drag a box to select features + markers, then delete them",
    elev:"drag to "+elevMode+" terrain (one stroke = one undo step) · drag the dashed border to move the region, corners to resize · unpainted terrain stays invisible · painting REPLACES glyph/biome relief at build time",
    marker:"click the map to place a marker", glyph:"click to stamp a "+glyphKind+" glyph",
    area:"click to trace a "+biomeKind+" region · double-click to close · Esc to cancel",
    river:"click to add river points · double-click to finish · Esc to cancel",
    road:"click to add road points · double-click to finish · Esc to cancel",
    border:"click to trace a political border · double-click to finish · Esc to cancel",
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
  const [wx0,wz1]=s2w(0,0), [wx1,wz0]=s2w(1000,640);
  let g="";
  for(let x=Math.ceil(wx0/step)*step; x<=wx1; x+=step){ const [sx]=w2s(x,0); g+='<line class="map-grid" x1="'+sx+'" y1="0" x2="'+sx+'" y2="640"/>'; }
  for(let z=Math.ceil(wz0/step)*step; z<=wz1; z+=step){ const [,sy]=w2s(0,z); g+='<line class="map-grid" x1="0" y1="'+sy+'" x2="1000" y2="'+sy+'"/>'; }
  const [ax]=w2s(0,0),[,ay]=w2s(0,0); g+='<line class="map-axis" x1="'+ax+'" y1="0" x2="'+ax+'" y2="640"/><line class="map-axis" x1="0" y1="'+ay+'" x2="1000" y2="'+ay+'"/>';
  // Scale indication: the map's world units convert to real meters via its SCALE CONTRACT
  // (units.unitsPerMeter — 1 for plain engine-meter maps, so behavior is unchanged by default).
  // (a) axis tick labels at every gridline — x values along the bottom edge, z along the left;
  // (b) a zoom-adaptive scale bar (1/2/5×10^n meters, 60-150px) bottom-right, m→km rollover.
  const upm=(activeMap().units&&activeMap().units.unitsPerMeter)||1;
  const fmtM=(v)=>{ const m=v*upm; return Math.abs(m)>=1000?(Math.round(m/100)/10)+"km":Math.round(m)+"m"; };
  for(let x=Math.ceil(wx0/step)*step; x<=wx1; x+=step){ const [sx]=w2s(x,0);
    if(sx>28&&sx<972) g+='<text class="map-tick" x="'+(sx+3)+'" y="634">'+fmtM(x)+'</text>'; }
  for(let z=Math.ceil(wz0/step)*step; z<=wz1; z+=step){ const [,sy]=w2s(0,z);
    if(sy>16&&sy<628) g+='<text class="map-tick" x="4" y="'+(sy-3)+'">'+fmtM(z)+'</text>'; }
  let bar=step; while(bar*mapScale<60) bar*=2; while(bar*mapScale>150) bar/=2;
  const bpx=bar*mapScale, bx1=1000-24-bpx, by=622;
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
  const ocean=activeMap().sea ? '<rect x="0" y="0" width="1000" height="640" fill="url(#biome-water)"/>' : '';
  // Painted elevation hillshade: rendered between the land fill and the semantic layers, so
  // relief reads as the terrain base while biomes/lines/pins stay legible on top. The raster is
  // only CREATED by an actual brush stroke (never by merely selecting the tool — creation flips
  // build-time precedence away from glyph/biome relief hints, so it must be an explicit act).
  let elevLayer="";
  {
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
  const outlines=feats.filter(f=>f.type==="area"&&f.kind==="outline").map(fsvg).join("");
  const areas=feats.filter(f=>f.type==="area"&&f.kind!=="outline").map(fsvg).join("");
  const lines=feats.filter(f=>f.type==="line"&&f.kind!=="border").map(fsvg).join("");
  const borders=feats.filter(f=>f.type==="line"&&f.kind==="border").map(fsvg).join("");
  const glyphs=feats.filter(f=>f.type==="glyph").map(fsvg).join("");
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
  const compass='<g transform="translate(956,44)"><circle r="18" fill="var(--panel)" stroke="var(--line)"/><text class="compass" x="0" y="-6" text-anchor="middle">N</text><line class="map-axis" x1="0" y1="10" x2="0" y2="-2" stroke="var(--muted)"/></g>';
  const elevCursor = mapTool==="elev" ? '<circle id="elev-cursor" r="'+(elevRadius*mapScale)+'" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0" style="pointer-events:none"/>' : '';
  // The elevation REGION is user-adjustable while the tool is armed: dashed outline drags to
  // move, corner handles resize (both one undo step). Cells never change — the rect is pure
  // world-space metadata, so moving slides the painted terrain and resizing stretches it.
  let elevRegion="";
  if(mapTool==="elev"){
    const er=EL.elevationOf(activeMap().id);
    if(er){
      const [rx,ry]=w2s(er.rect.x0,er.rect.z0);
      const rw=er.rect.w*mapScale, rh=er.rect.h*mapScale;
      const corners=[["nw",rx,ry],["ne",rx+rw,ry],["sw",rx,ry+rh],["se",rx+rw,ry+rh]];
      elevRegion='<g id="elev-region">'
        // The hit stroke must be PAINTED (opacity 0.004, imperceptible): Chrome's real-event hit
        // testing skips a fully-transparent stroke even under pointer-events:stroke, while
        // elementFromPoint honors it — a genuinely painted stroke hits in both paths.
        +'<rect id="elev-rect-hit" x="'+rx+'" y="'+ry+'" width="'+rw+'" height="'+rh+'" fill="none" stroke="#000" stroke-opacity="0.004" stroke-width="14" style="cursor:move;pointer-events:stroke"/>'
        +'<rect x="'+rx+'" y="'+ry+'" width="'+rw+'" height="'+rh+'" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="8 5" opacity=".8" style="pointer-events:none"/>'
        +corners.map(c=>'<g class="elev-hn" data-corner="'+c[0]+'" style="cursor:'+(c[0]==="nw"||c[0]==="se"?"nwse-resize":"nesw-resize")+'">'
          // painted near-invisible halo = a ~13px grab radius around each corner handle
          +'<circle cx="'+c[1]+'" cy="'+c[2]+'" r="13" fill="#000" fill-opacity="0.004"/>'
          +'<rect x="'+(c[1]-6)+'" y="'+(c[2]-6)+'" width="12" height="12" fill="#fff" stroke="var(--accent)" stroke-width="1.5"/></g>').join("")
        +'</g>';
    }
  }
  svg.innerHTML = biomeDefs() + ocean + g + outlines + elevLayer + areas + lines + borders + glyphs + draw + pins + compass + elevRegion + elevCursor;
  renderLayers(); syncUndoButtons();
  svg.querySelectorAll(".pin").forEach(p=>{ p.addEventListener("mousedown",(e)=>startPinDrag(e,p.dataset.id)); p.addEventListener("dblclick",(e)=>{e.stopPropagation(); const loc=mapMarkers().find(l=>l.id===p.dataset.id); if(loc&&loc.mapLink) switchMap(loc.mapLink);}); });
  if(mapTool==="select") bindFeatureEditing(svg);
  bindElevRegion(svg);
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
  const f=curFeatures();
  if(!f.length){ el.className="map-layers empty"; el.innerHTML=""; return; }
  el.className="map-layers";
  el.innerHTML='<div class="lh"><b>Features ('+f.length+')</b><button class="clr" id="lyr-clear">Clear all</button></div>'
    +f.map((x,i)=>'<div class="lr'+(x.id===selFeat?" sel":"")+'" data-i="'+i+'"><span class="sw" style="background:'+featSwatch(x)+'"></span><span class="nm">'+esc(featLabel(x))+'</span><button class="x" data-i="'+i+'" title="Delete this feature">×</button></div>').join("");
  document.getElementById("lyr-clear").onclick=clearMapFeatures;
  el.querySelectorAll(".lr .x").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); deleteFeatById(curFeatures()[+b.dataset.i].id,false); });
  el.querySelectorAll(".lr").forEach(r=>{ r.onclick=()=>{ mapTool="select"; selFeat=curFeatures()[+r.dataset.i].id; renderMap(); };
    r.onmouseenter=()=>hlFeat(+r.dataset.i,true); r.onmouseleave=()=>hlFeat(+r.dataset.i,false); });
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
  setTimeout(()=>document.addEventListener("mousedown",function h(){ m.remove(); document.removeEventListener("mousedown",h); }),0);
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
  document.querySelectorAll(".map-head .tool[data-tool]").forEach(b=>b.onclick=()=>{ mapTool=b.dataset.tool; drawPts=[]; renderMap(); });
  const gp=document.getElementById("glyph-pick"); if(gp) gp.onchange=(e)=>{ glyphKind=e.target.value; hint(); };
  const bp=document.getElementById("biome-pick"); if(bp) bp.onchange=(e)=>{ biomeKind=e.target.value; hint(); };
  const dc=document.getElementById("draw-color"); if(dc) dc.oninput=(e)=>{ drawColor=e.target.value; redrawMap(); };
  const seaBtn=document.getElementById("map-sea"); if(seaBtn) seaBtn.onclick=()=>{
    const m=activeMap();
    commit(H.cmdSetMapProp(activeMapId,"sea",m.sea,!m.sea));
    renderMap(); };
  const em1=document.getElementById("elev-mode"); if(em1) em1.onchange=(e)=>{ elevMode=e.target.value; renderMap(); };
  const er1=document.getElementById("elev-radius"); if(er1) er1.oninput=(e)=>{ elevRadius=Number(e.target.value); const c=document.getElementById("elev-cursor"); if(c) c.setAttribute("r",elevRadius*mapScale); };
  const es1=document.getElementById("elev-strength"); if(es1) es1.oninput=(e)=>{ elevStrength=Number(e.target.value); };
  const el1=document.getElementById("elev-levely"); if(el1) el1.onchange=(e)=>{ elevLevelY=Number(e.target.value)||0; };
  const sea1=document.getElementById("elev-sea"); if(sea1){
    const seaBefore=typeof activeMap().seaLevel==="number"?activeMap().seaLevel:0;
    sea1.oninput=(e)=>{ const v=Number(e.target.value); activeMap().seaLevel=v; const lab=document.getElementById("elev-sea-val"); if(lab) lab.textContent=v+"m"; elevRev++; refreshElevImage(); };
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
    if(mapTool==="marker"){ openInspector(null,{x:Math.round(x),z:Math.round(z)},e.clientX,e.clientY); return; }
    if(mapTool==="glyph"){ commit(H.cmdAddFeature(activeMapId,{id:fid(),type:"glyph",glyph:glyphKind,x:Math.round(x),z:Math.round(z)})); return; }
    if(["river","road","area","outline","border"].includes(mapTool)){
      for(let i=0;i<drawPts.length;i++){ const [px,py]=w2s(drawPts[i][0],drawPts[i][1]); if(Math.hypot(px-mx,py-my)<9){ drawPts.splice(i,1); redrawMap(); return; } }
      drawPts.push([Math.round(x),Math.round(z)]); redrawMap(); return; }
    if(mapTool==="lasso"){ mapDrag={type:"lasso",x0:mx,y0:my,x1:mx,y1:my}; return; }
    if(mapTool==="select"&&selFeat){ selFeat=null; redrawMap(); }
    mapDrag={type:"pan",mx,my,px:mapPan.x,pz:mapPan.z}; svg.classList.add("grabbing"); });
  svg.addEventListener("dblclick",(e)=>{ if(["river","road","area","outline","border"].includes(mapTool)) finishDraw(); });
  window.addEventListener("mousemove",onMapMove); window.addEventListener("mouseup",onMapUp);
  svg.addEventListener("mousemove",(e)=>{ const [mx,my]=evtVB(e,svg); const [wx,wz]=s2w(mx,my);
    const c=document.getElementById("map-coord");
    if(c){ const er=EL.elevationOf(activeMap().id);
      c.textContent="x "+Math.round(wx)+"  z "+Math.round(wz)+(er?"  y "+EL.sampleY(er,wx,wz).toFixed(1)+"m":""); }
    const cur=document.getElementById("elev-cursor");
    if(cur){ cur.setAttribute("cx",mx); cur.setAttribute("cy",my); cur.setAttribute("opacity","0.9"); } });
  window.addEventListener("keydown",mapKey); window.addEventListener("keyup",mapKeyUp);
}
function mapKey(e){ if(S.activeView!=="map") return;
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement||{}).tagName||"");
  if((e.ctrlKey||e.metaKey)&&!typing&&(e.key==="z"||e.key==="Z")){ e.preventDefault(); if(e.shiftKey) doRedo(); else doUndo(); return; }
  if((e.ctrlKey||e.metaKey)&&!typing&&(e.key==="y"||e.key==="Y")){ e.preventDefault(); doRedo(); return; }
  if((e.key===" "||e.code==="Space")&&!typing){ if(!spaceDown){ spaceDown=true; document.getElementById("map-svg")?.classList.add("space"); } e.preventDefault(); return; }
  if(e.key==="Escape"){ drawPts=[]; selFeat=null; document.getElementById("feat-menu")?.remove(); redrawMap(); }
  else if(e.key==="Enter"&&drawPts.length&&!typing) finishDraw();
  else if((e.key==="Delete"||e.key==="Backspace")&&selFeat&&!typing){ e.preventDefault(); deleteFeatById(selFeat,true); } }
function mapKeyUp(e){ if(e.key===" "||e.code==="Space"){ spaceDown=false; document.getElementById("map-svg")?.classList.remove("space"); } }
function finishDraw(){
  const pts=drawPts.filter((p,i)=> i===0 || p[0]!==drawPts[i-1][0] || p[1]!==drawPts[i-1][1]);
  drawPts=[];
  if(pts.length<2){ redrawMap(); return; }
  let feature;
  if(["river","road","border"].includes(mapTool)) feature={id:fid(),type:"line",kind:mapTool,points:pts,color:drawColor};
  else if(mapTool==="area") feature={id:fid(),type:"area",kind:"biome",biome:biomeKind,points:pts};
  else feature={id:fid(),type:"area",kind:"outline",points:pts,fill:drawColor};
  commit(H.cmdAddFeature(activeMapId, feature)); }
// ── elevation stroke helpers ─────────────────────────────────────────────────────────────────
function elevDab(er,wx,wz,drag){
  const bb=EL.brushDab(er,wx,wz,{mode:elevMode,radiusM:elevRadius,strength:elevStrength,levelY:elevLevelY});
  if(bb){
    drag.bbox = drag.bbox
      ? {c0:Math.min(drag.bbox.c0,bb.c0),r0:Math.min(drag.bbox.r0,bb.r0),c1:Math.max(drag.bbox.c1,bb.c1),r1:Math.max(drag.bbox.r1,bb.r1)}
      : bb;
    elevRev++; refreshElevImage();
  }
}
function bindElevRegion(svg){
  const hit=svg.querySelector("#elev-rect-hit");
  if(hit) hit.addEventListener("mousedown",(e)=>{ e.stopPropagation();
    const er=EL.elevationOf(activeMap().id); if(!er) return;
    const [mx,my]=evtVB(e,svg); const [wx,wz]=s2w(mx,my);
    mapDrag={type:"elevrect-move",mapId:activeMapId,raster:er,start:{...er.rect},wx0:wx,wz0:wz}; });
  svg.querySelectorAll(".elev-hn").forEach(hn=>hn.addEventListener("mousedown",(e)=>{ e.stopPropagation();
    const er=EL.elevationOf(activeMap().id); if(!er) return;
    mapDrag={type:"elevrect-size",mapId:activeMapId,raster:er,start:{...er.rect},corner:hn.dataset.corner}; }));
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
  else if(mapDrag.type==="elevrect-move"){
    const [wx,wz]=s2w(mx,my); const er=mapDrag.raster;
    er.rect.x0=mapDrag.start.x0+Math.round(wx-mapDrag.wx0);
    er.rect.z0=mapDrag.start.z0+Math.round(wz-mapDrag.wz0);
    redrawMap(); }
  else if(mapDrag.type==="elevrect-size"){
    const [wx,wz]=s2w(mx,my); const er=mapDrag.raster; const s=mapDrag.start;
    // Anchor the opposite corner; clamp the span so the region can't collapse.
    const ax=mapDrag.corner.includes("w")?s.x0+s.w:s.x0;
    const az=mapDrag.corner.includes("n")?s.z0+s.h:s.z0;
    const w=Math.max(40,Math.round(Math.abs(wx-ax))), h=Math.max(40,Math.round(Math.abs(wz-az)));
    er.rect.x0=Math.round(Math.min(ax, mapDrag.corner.includes("w")?ax-w:ax+w));
    er.rect.z0=Math.round(Math.min(az, mapDrag.corner.includes("n")?az-h:az+h));
    er.rect.w=w; er.rect.h=h;
    redrawMap(); }
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
  if(d.type==="elevrect-move"||d.type==="elevrect-size"){
    if(JSON.stringify(d.raster.rect)!==JSON.stringify(d.start)){
      d.raster.dirty=true;
      commit(H.cmdSetRasterRect(d.mapId,d.raster,d.start,{...d.raster.rect}),{applied:true});
    }
    return; }
  if(d.type==="elev"){
    // One stroke = one undo step: bbox slices of the pre-stroke snapshot vs the current cells.
    if(d.bbox){
      const beforeRaster={w:d.raster.w,h:d.raster.h,cells:d.before};
      const before=H.rasterBboxSnapshot(beforeRaster,d.bbox);
      const after=H.rasterBboxSnapshot(d.raster,d.bbox);
      commit(H.cmdPatchRaster(d.mapId,d.raster,d.bbox,before,after),{applied:true});
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
  S.state.maps.push({id,name,scope:"region",parent:activeMapId,features:[],units:{kind:"m",unitsPerMeter:1,origin:[0,0]}}); await flushMapSave(); switchMap(id); }

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
