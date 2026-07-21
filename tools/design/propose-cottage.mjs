// propose-cottage.mjs — import the QC'd cottage THROUGH the approval queue: connect as a
// builder.review agent and asset.place it. builder.review's mutating skills are HELD, so this
// returns a pending approvalId and the placement waits for the reviewer (you, in the editor).
const URL = "ws://localhost:8787/";
const TOKEN = process.env.LIMINA_EDITOR_TOKEN || process.argv[2];
const ws = new WebSocket(URL); let idc = 1; const pend = new Map();
function rpc(method, params={}) { return new Promise((res,rej)=>{ const id=idc++; pend.set(id,{res,rej}); ws.send(JSON.stringify({jsonrpc:"2.0",id,method,params})); setTimeout(()=>{ if(pend.has(id)){pend.delete(id);rej(new Error(method+" timeout"));}},30000); }); }
ws.addEventListener("message", (ev)=>{ let m; try{m=JSON.parse(ev.data);}catch{return;} if(m&&m.id!=null&&pend.has(m.id)){ const {res,rej}=pend.get(m.id); pend.delete(m.id); if(m.error)rej(new Error(JSON.stringify(m.error))); else res(m.result); }});
ws.addEventListener("error",(e)=>{ console.error("ws error", e.message||e); process.exit(1); });
ws.addEventListener("open", async ()=>{
  try {
    await rpc("initialize", { agentId:"qc-reviewer", sessionId:"qc-1", profile:"builder.review", authToken:TOKEN });
    console.log("connected as builder.review");
    const r = await rpc("tools/call", { name:"asset.place", arguments:{
      assetId:"cottage-authored.glb", position:[14,0,6], ground:true,
      qcRender:"qc/cottage-authored.png",
      qcChecks:{ textured:true, scale:true, integrity:true, theme:null }
    }});
    console.log("proposal response:", JSON.stringify(r));
    // A held action returns success:false + error.code "pending_approval", message = approvalId.
    const err = r && r.error;
    if (err && err.code === "pending_approval") console.log("\n  HELD for approval — approvalId:", err.message, "\n  Open the editor Approval panel to review + Approve.\n");
    else console.log("\n  (not held — check whether the review gate applied)\n");
    ws.close(); process.exit(0);
  } catch(e){ console.error("propose failed:", e.message); process.exit(1); }
});
