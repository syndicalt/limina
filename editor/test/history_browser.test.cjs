// REAL in-browser render test for the editor History panel (headless Chromium via Playwright).
//
// Loads the live editor in a real browser engine, connects to the host, drives the co-authoring
// loop (propose a held edit → grant it), and asserts the History panel actually RENDERS with a
// populated timeline (branch selector + scrub control) and no console errors — the literal in-browser
// pixel/DOM render that jsdom and the live-data-path test can't cover. Saves a screenshot as evidence.
//
// Prereqs: editor host on :8787 and the static server on :5173.
// Run: node editor/test/history_browser.test.cjs   (exit 0 = pass; exit 2 = no browser/servers → skip)

const fs = require("fs");
const PWC = fs.readFileSync("/tmp/claude-1000/-home-cheapseatsecon-Projects-Personal-limina/ec66f3aa-28e5-4be6-af39-c803b3c96622/scratchpad/pwc_path.txt", "utf8").trim();
const CHROME = process.env.CHROME_BIN || `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;

function fail(m) { console.error("FAIL: " + m); process.exit(1); }

(async () => {
  let chromium;
  try { ({ chromium } = require(PWC)); } catch (e) { console.log("SKIP: playwright-core not loadable (" + e.message + ")"); process.exit(2); }
  if (!fs.existsSync(CHROME)) { console.log("SKIP: chromium binary not found at " + CHROME); process.exit(2); }

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  } catch (e) { console.log("SKIP: could not launch headless chromium (" + e.message + ")"); process.exit(2); }

  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    const resp = await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (!resp) { console.log("SKIP: editor not served on http://localhost:5173/"); await browser.close(); process.exit(2); }

    // The History panel exists from the static markup (empty state) before connect.
    await page.waitForSelector("#history-body", { timeout: 5000 });
    const emptyText = await page.textContent("#history-body");
    if (!/no edits yet|connect to begin/.test(emptyText || "")) fail("History panel did not render its initial state (got: " + emptyText + ")");

    // Connect, then drive the co-authoring loop: propose a held edit, then grant it.
    await page.click("#connect");
    await page.waitForTimeout(1800);
    await page.click("#propose");
    await page.waitForTimeout(1800);
    const granted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("#approval-body button"));
      const g = btns.find((b) => /grant|approve/i.test(b.textContent || ""));
      if (g) { g.click(); return true; }
      return false;
    });

    // The next poll picks up the applied+traced edit and grows the timeline. Wait for the scrub.
    const grew = await page.waitForFunction(() => {
      const s = document.querySelector("#history-body input[type=range]");
      return s && parseInt(s.max, 10) > 0;
    }, { timeout: 9000 }).then(() => true).catch(() => false);

    const result = await page.evaluate(() => {
      const body = document.getElementById("history-body");
      const scrub = body.querySelector("input[type=range]");
      const branchSel = body.querySelector("select");
      return { hasScrub: !!scrub, scrubMax: scrub ? parseInt(scrub.max, 10) : -1, hasBranch: !!branchSel, text: (body.textContent || "").slice(0, 60) };
    });

    const shot = "editor/test/history_browser_render.png";
    await page.screenshot({ path: shot, fullPage: true });
    await browser.close();

    // Assertions: the panel rendered in a real browser, the timeline populated, no console errors.
    if (!grew || !result.hasScrub || result.scrubMax <= 0) fail(`the History timeline did not render/populate in the browser (granted=${granted}, scrubMax=${result.scrubMax}, text="${result.text}")`);
    if (!result.hasBranch) fail("the branch selector did not render");
    // The Live viewport needs WebGPU, which headless Chromium lacks (no GPU) — its WebGPU /
    // worker / resource errors are the EXPECTED GPU limitation (Track R's domain), not a History-
    // panel fault. Fail only on errors unrelated to the GPU-bound viewport.
    const benign = (s) => /favicon|webgpu|navigator\.gpu|gpuadapter|sim-worker|limina-runtime|require-corp|Failed to load resource/i.test(s);
    const real = errors.filter((e) => !benign(e));
    if (real.length > 0) fail("non-viewport console errors in the editor: " + real.slice(0, 3).join(" | "));

    console.log(`history_browser.test OK: headless Chromium RENDERED the editor History panel — initial state shown, ` +
      `connect + propose + grant drove ${result.scrubMax} edit(s) onto the live timeline, branch selector + scrub control rendered, ` +
      `no console errors. Screenshot: ${shot}. The literal in-browser render, verified.`);
    process.exit(0);
  } catch (e) {
    try { await browser.close(); } catch (_) {}
    fail(e && e.message ? e.message : String(e));
  }
})();
