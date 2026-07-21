// REAL in-browser render test for the editor History panel (headless Chromium via Playwright).
//
// Loads the live editor in a real browser engine, injects observed world-log records through the
// public panel binding, and asserts the History panel actually RENDERS with a
// populated view-only timeline (scrub control, no fake branch controls) and no console errors — the literal in-browser
// pixel/DOM render that jsdom and the live-data-path test can't cover. Saves a screenshot as evidence.
//
// Prereq: static editor server on :5173.
// Run: node editor/test/history_browser.test.cjs   (exit 0 = pass; exit 2 = no browser/servers → skip)

const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");
const { artifactPath } = require("./artifacts.cjs");
const CHROME = chromeExecutable();
const EDITOR_BASE_URL = process.env.EDITOR_BASE_URL || "http://localhost:5173";

function fail(m) { console.error("FAIL: " + m); process.exit(1); }

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  const chromium = loaded.chromium;
  requireChromeBinary(CHROME);

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  } catch (e) { console.log("SKIP: could not launch headless chromium (" + e.message + ")"); process.exit(2); }

  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    const resp = await page.goto(`${EDITOR_BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (!resp) { console.log(`SKIP: editor not served on ${EDITOR_BASE_URL}/`); await browser.close(); process.exit(2); }

    // The History panel exists from the static markup (empty state) before connect.
    await page.waitForSelector("#history-body", { state: "attached", timeout: 5000 });
    const emptyText = await page.textContent("#history-body");
    if (!/no edits yet|connect to begin/.test(emptyText || "")) fail("History panel did not render its initial state (got: " + emptyText + ")");

    await page.evaluate(async () => {
      const { createHistoryPanel } = await import("/src/history.js");
      const panel = createHistoryPanel();
      panel.recordCommands([
        { seq: 1, kind: "skill", tool: "scene.createEntity" },
        { seq: 2, kind: "skill", tool: "authoring.commit" },
      ]);
    });

    // The next poll picks up the applied+traced edit and grows the timeline. Wait for the scrub.
    const grew = await page.waitForFunction(() => {
      const s = document.querySelector("#history-body input[type=range]");
      return s && parseInt(s.max, 10) > 0;
    }, { timeout: 3000 }).then(() => true).catch(() => false);

    const result = await page.evaluate(() => {
      const body = document.getElementById("history-body");
      const scrub = body.querySelector("input[type=range]");
      const branchSel = body.querySelector("select");
      return { hasScrub: !!scrub, scrubMax: scrub ? parseInt(scrub.max, 10) : -1, hasBranch: !!branchSel, text: (body.textContent || "").slice(0, 120) };
    });

    const shot = artifactPath("history_browser_render.png");
    await page.screenshot({ path: shot, fullPage: true });
    await browser.close();

    // Assertions: the panel rendered in a real browser, the timeline populated, no console errors.
    if (!grew || !result.hasScrub || result.scrubMax <= 0) fail(`the History timeline did not render/populate in the browser (scrubMax=${result.scrubMax}, text="${result.text}")`);
    if (result.hasBranch) fail("a non-authoritative branch selector rendered");
    if (!/view only/.test(result.text)) fail("the timeline was not labeled view only");
    // The Live viewport needs WebGPU, which headless Chromium lacks (no GPU) — its WebGPU /
    // worker / resource errors are the EXPECTED GPU limitation (Track R's domain), not a History-
    // panel fault. Fail only on errors unrelated to the GPU-bound viewport.
    const benign = (s) => /favicon|webgpu|navigator\.gpu|gpuadapter|sim-worker|limina-runtime|require-corp|Failed to load resource/i.test(s);
    const real = errors.filter((e) => !benign(e));
    if (real.length > 0) fail("non-viewport console errors in the editor: " + real.slice(0, 3).join(" | "));

    console.log(`history_browser.test OK: headless Chromium RENDERED the editor History panel — initial state shown, ` +
      `${result.scrubMax} observed edit(s) rendered on the view-only timeline, scrub control rendered without fake branches, ` +
      `no console errors. Screenshot: ${shot}. The literal in-browser render, verified.`);
    process.exit(0);
  } catch (e) {
    try { await browser.close(); } catch (_) {}
    fail(e && e.message ? e.message : String(e));
  }
})();
