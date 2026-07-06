// propose-asset.mjs <assetId> <qcRender> <x> <z> — import a QC'd asset THROUGH the approval queue.
const [assetId, qcRender, x, z] = process.argv.slice(2);
const TOKEN = process.env.LIMINA_EDITOR_TOKEN;
const ws=new WebSocket("ws://localhost:8787/");let idc=1;const p=new Map();
function rpc(m,pa={}){return new Promise((res,rej)=>{const id=idc++;p.set(id,{res,rej});ws.send(JSON.stringify({jsonrpc:"2.0",id,method:m,params:pa}));setTimeout(()=>{if(p.has(id)){p.delete(id);rej(new Error("timeout"));}},30000);});}
ws.addEventListener("message",(e)=>{let m;try{m=JSON.parse(e.data);}catch{return;}if(m&&m.id!=null&&p.has(m.id)){const{res,rej}=p.get(m.id);p.delete(m.id);if(m.error)rej(new Error(JSON.stringify(m.error)));else res(m.result);}});
ws.addEventListener("error",(e)=>{console.error("ws",e.message||e);process.exit(1);});
ws.addEventListener("open",async()=>{try{
  await rpc("initialize",{agentId:"qc-reviewer",sessionId:"qc-1",profile:"builder.review",authToken:TOKEN});
  await rpc("tools/call",{name:"asset.place",arguments:{assetId,position:[Number(x),0,Number(z)],ground:true,qcRender,qcChecks:{textured:true,scale:true,integrity:true,theme:null}}}).catch(e=>{
    const m=JSON.parse(e.message); if(m.data&&m.data.error&&m.data.error.code==="pending_approval"){console.log("HELD for approval:",m.data.error.message);} else throw e;
  });
  ws.close();process.exit(0);
}catch(e){console.error("propose failed:",e.message);process.exit(1);}});
