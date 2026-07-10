const assert = require("node:assert/strict");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  const browser = await loaded.chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors = [];
  const websocketUrls = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => websocketUrls.push(socket.url()));
  const host = process.env.PLAY_UAT_HOST || "ws://localhost:8790/";
  const token = process.env.PLAY_UAT_TOKEN || "play-uat-token";

  const backingRatio = async (selector) => page.$eval(selector, (canvas) => ({
    x: canvas.width / canvas.clientWidth,
    y: canvas.height / canvas.clientHeight,
    width: canvas.width,
    height: canvas.height,
  }));
  const expectRatio = (actual, expected, label) => {
    assert.ok(Math.abs(actual.x - expected) < 0.02 && Math.abs(actual.y - expected) < 0.02,
      `${label} backing ratio ${actual.x.toFixed(3)}x${actual.y.toFixed(3)}, expected ${expected}`);
  };

  try {
    await page.addInitScript(() => localStorage.setItem("limina.editor.serverUrl", "ws://localhost:8787/"));
    await page.goto(`http://localhost:5173/?server=${encodeURIComponent(host)}`, { waitUntil: "domcontentloaded" });
    assert.equal(await page.inputValue("#url"), host, "explicit launch server must override a stale saved default");
    await page.waitForTimeout(1_100);
    assert.deepEqual(websocketUrls, [], "viewport must not connect before the editor connection is authorized");
    await page.fill("#auth-token", token);
    await page.click("#connect");
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "connected", null, { timeout: 10_000 });
    await page.waitForFunction(() => /live|following/.test(document.getElementById("viewport-status")?.textContent || ""), null, { timeout: 20_000 });

    await page.waitForFunction(() => {
      const canvas = document.getElementById("editor-viewport");
      return canvas && Math.abs(canvas.width / canvas.clientWidth - 1.5) < 0.02;
    }, null, { timeout: 20_000 });
    expectRatio(await backingRatio("#editor-viewport"), 1.5, "Balanced Edit");
    await page.click('[data-quality-tier="cinematic"]');
    await page.waitForFunction(() => {
      const canvas = document.getElementById("editor-viewport");
      return Math.abs(canvas.width / canvas.clientWidth - 2) < 0.02;
    });
    expectRatio(await backingRatio("#editor-viewport"), 2, "Cinematic Edit");
    await page.click('[data-quality-tier="performance"]');
    await page.waitForFunction(() => {
      const canvas = document.getElementById("editor-viewport");
      return Math.abs(canvas.width / canvas.clientWidth - 1) < 0.02;
    });
    expectRatio(await backingRatio("#editor-viewport"), 1, "Performance Edit");

    await page.click("#viewport-play");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Playing", null, { timeout: 30_000 });
    expectRatio(await backingRatio(".editor-play-canvas"), 1, "Performance Play");
    await page.click('[data-quality-tier="cinematic"]');
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".editor-play-canvas");
      return canvas && Math.abs(canvas.width / canvas.clientWidth - 2) < 0.02;
    });
    expectRatio(await backingRatio(".editor-play-canvas"), 2, "Cinematic Play");

    await page.click("#viewport-stop");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Edit", null, { timeout: 30_000 });
    await page.waitForFunction(() => {
      const canvas = document.getElementById("editor-viewport");
      return !canvas.hidden && Math.abs(canvas.width / canvas.clientWidth - 2) < 0.02;
    });
    expectRatio(await backingRatio("#editor-viewport"), 2, "restored Cinematic Edit");

    await page.waitForFunction(() => /FPS/.test(document.getElementById("viewport-render-telemetry")?.textContent || ""), null, { timeout: 4_000 });
    const telemetry = await page.$eval("#viewport-render-telemetry", (output) => ({ text: output.textContent, title: output.title }));
    assert.match(telemetry.text, /FPS .* p95 .* ms .* draws .* triangles/);
    assert.match(telemetry.title, /cinematic/i);
    assert.match(telemetry.title, /DPR 2\.00/);
    assert.ok(websocketUrls.length >= 2, "editor and viewport connections were not both observed");
    assert.equal(websocketUrls.every((url) => url === host), true,
      `unexpected WebSocket endpoint(s): ${websocketUrls.join(", ")}`);
    assert.deepEqual(pageErrors, [], `graphics workflow page errors: ${pageErrors.join(" | ")}`);
    await page.screenshot({ path: "/tmp/limina-graphics-workflow.png", fullPage: true });
    console.log(`graphics_workflow_browser.test OK: DPR 2 tiers 1/1.5/2, Play propagation, Edit restoration, telemetry '${telemetry.text}'`);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
