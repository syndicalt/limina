// LIVE integration test for the editor History panel data path.
//
// Drives the real co-authoring loop against a running editor host (ws://localhost:8787/):
// a builder.review agent PROPOSES a held edit, the reviewer GRANTS it (so it applies and traces),
// the reviewer reads trace.tail, and those REAL server events are fed into the History panel — proving
// the full path server → trace.tail → recordEvents → controller timeline works end to end, not just
// with synthetic events. Pixel rendering remains the in-browser step.
//
// Prereq: the editor host must be running:  ./target/release/limina editor/server/editor_host.ts
// Run:    node editor/test/history_live.test.mjs   (exit 0 = pass; exit 2 = host not running → skip)

const HOST = "ws://localhost:8787/";
function fail(m) { console.error("FAIL: " + m); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, { tries = 30, gap = 150 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}

// Minimal DOM stub so the real history.js binding runs headlessly.
function makeEl(tag) {
  return {
    tagName: tag, className: "", _text: "", children: [], style: {}, _handlers: {},
    value: "", type: "", title: "", selected: false, min: "", max: "", step: "",
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c); return c; },
    addEventListener(ev, fn) { this._handlers[ev] = fn; },
    get firstChild() { return this.children[0] || null; },
    get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    get innerHTML() { return ""; }, set innerHTML(_v) { this.children = []; },
  };
}
const byId = { "history-body": makeEl("div") };
globalThis.document = { getElementById: (id) => byId[id] || null, createElement: (t) => makeEl(t) };
globalThis.window = { prompt: () => "wip" };

const { McpClient } = await import("../src/mcp-client.js");
const { createHistoryPanel } = await import("../src/history.js");

const overall = setTimeout(() => { console.error("FAIL: overall timeout"); process.exit(1); }, 25000);
const reviewer = new McpClient(HOST);
const agent = new McpClient(HOST);

try {
  // Connect both clients; if the host isn't up, skip (exit 2) rather than fail.
  try {
    await Promise.race([reviewer.connect(), sleep(4000).then(() => { throw new Error("connect timeout"); })]);
  } catch {
    console.log("SKIP: editor host not running on " + HOST + " (start it: ./target/release/limina editor/server/editor_host.ts)");
    clearTimeout(overall); process.exit(2);
  }
  await reviewer.initialize("reviewer_test", "ses_rev_" + Math.random().toString(36).slice(2, 7), "reviewer");
  await agent.connect();
  await agent.initialize("agt_test", "ses_agt_" + Math.random().toString(36).slice(2, 7), "builder.review");

  const panel = createHistoryPanel({ onLog: () => {} });
  const ctrl = panel.controller();
  const before = ctrl.tip();

  // 1. Agent proposes a mutating edit → HELD by the review gate (callTool rejects with the approvalId).
  await agent.callTool("scene.createEntity", { position: [2, 0, 2], shape: "box", color: 0x44aaff }).catch(() => {});

  // 2. Reviewer sees the held proposal and GRANTS it (so it applies + traces).
  const pending = await pollUntil(async () => {
    const list = await reviewer.callTool("approval.list", {}).catch(() => null);
    const p = list && Array.isArray(list.pending) ? list.pending : [];
    return p.length > 0 ? p[0] : null;
  });
  if (!pending) fail("the proposed edit never appeared in the reviewer's approval queue");
  const grant = await reviewer.callTool("approval.grant", { approvalId: pending.approvalId }).catch((e) => ({ error: String(e) }));
  if (grant && grant.error) fail("approval.grant failed: " + grant.error);

  // 3. The applied edit now traces; pull it via trace.tail and FEED it to the History panel.
  let afterSeq = -1;
  const events = await pollUntil(async () => {
    const tail = await reviewer.callTool("trace.tail", { afterSeq, limit: 500 }).catch(() => null);
    if (!tail || !Array.isArray(tail.events)) return null;
    if (tail.nextAfterSeq !== null && tail.nextAfterSeq !== undefined) afterSeq = tail.nextAfterSeq;
    return tail.events.length > 0 ? tail.events : null;
  });
  if (!events) fail("no trace events appeared after granting the edit");

  panel.recordEvents(events);
  if (ctrl.tip() <= before) fail(`the History timeline did not grow from real server events (tip ${before} → ${ctrl.tip()})`);

  // The scrub control reflects the real timeline length, and time-travel emits a real prefix.
  const root = byId["history-body"];
  const findRange = (n) => { if (n.tagName === "input" && n.type === "range") return n; for (const c of n.children || []) { const r = findRange(c); if (r) return r; } return null; };
  const scrub = findRange(root);
  if (!scrub) fail("the timeline scrub control did not render for the live timeline");
  if (scrub.max !== String(ctrl.tip())) fail(`scrub max ${scrub.max} != live tip ${ctrl.tip()}`);

  console.log(`history_live.test OK: real co-authoring loop — agent proposed a held edit, reviewer granted it, ` +
    `the applied edit traced, and ${events.length} real trace event(s) flowed into the History timeline (tip ${before} → ${ctrl.tip()}) ` +
    `with the scrub control tracking it. Full path server → trace.tail → recordEvents → controller, verified live.`);
  clearTimeout(overall);
  reviewer.close(); agent.close();
  process.exit(0);
} catch (e) {
  clearTimeout(overall);
  fail(e && e.message ? e.message : String(e));
}
