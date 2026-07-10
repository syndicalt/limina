const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

(async () => {
  const host = process.env.PLAY_UAT_HOST || "ws://localhost:8790/";
  const token = process.env.PLAY_UAT_TOKEN || "play-uat-token";
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  const headless = process.env.PLAY_UAT_HEADFUL !== "1";
  const browser = await loaded.chromium.launch({
    headless,
    executablePath,
    args: headless ? ["--no-sandbox", "--enable-unsafe-swiftshader"] : ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`http://localhost:5173/?server=${encodeURIComponent(host)}`, { waitUntil: "domcontentloaded" });
    await page.fill("#auth-token", token);
    await page.click("#connect");
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "connected", null, { timeout: 10_000 });
    console.log("UAT checkpoint: connected");
    await page.waitForFunction(() => /live|following/.test(document.getElementById("viewport-status")?.textContent || ""), null, { timeout: 20_000 });
    console.log("UAT checkpoint: edit runtime ready");
    const preflightHead = await page.evaluate(async () => {
      const { refreshAuthoringHead } = await import("./src/write-client.js");
      return refreshAuthoringHead();
    });
    console.log("UAT checkpoint: authoritative head", preflightHead.revision);

    await page.click("#viewport-play");
    try {
      await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Playing", null, { timeout: 30_000 });
    } catch (error) {
      console.log("UAT start diagnostic:", await page.evaluate(() => ({
        phase: document.getElementById("viewport-play-state")?.textContent,
        source: document.getElementById("viewport-play-source")?.textContent,
        viewport: document.getElementById("viewport-status")?.textContent,
        playCanvases: document.querySelectorAll(".editor-play-canvas").length,
        editCanvasHidden: document.getElementById("editor-viewport")?.hidden,
        progress: document.body.dataset.playProgress,
      })));
      throw error;
    }
    console.log("UAT checkpoint: playing");
    const playingSource = await page.textContent("#viewport-play-source");
    assert.match(playingSource, /grey-field · r\d+ · sha256:/, "Playing must show captured project/revision/head identity");
    await page.screenshot({ path: "/tmp/limina-play-workflow-playing.png", fullPage: true });

    const rejectedWrite = await page.evaluate(async () => {
      const writer = await import("./src/write-client.js");
      try {
        await writer.deformTerrain([0, 0], 1, 1, "raise", "smooth");
        return "write unexpectedly succeeded";
      } catch (error) { return error.message; }
    });
    assert.match(rejectedWrite, /read-only while Play is playing/);

    await page.click("#viewport-pause");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Paused");
    console.log("UAT checkpoint: paused");
    assert.equal(await page.getAttribute("#viewport-pause", "aria-label"), "Resume Play");
    await page.waitForTimeout(150);
    await page.screenshot({ path: "/tmp/limina-play-workflow-paused.png", fullPage: true });

    await page.evaluate(async ({ host, token }) => {
      const { McpClient } = await import("./src/mcp-client.js");
      const external = new McpClient(host, token);
      await external.connect();
      await external.initialize("play_uat_external", "ses_play_uat_external", "builder.readWrite");
      await external.callTool("scene.createEntity", { position: [6, 0.5, 2], shape: "box", color: 0x37b26c });
      external.close();
    }, { host, token });
    await page.waitForFunction(() => /stale/.test(document.getElementById("viewport-play-state")?.textContent || ""), null, { timeout: 10_000 });
    console.log("UAT checkpoint: stale update buffered");

    await page.click("#viewport-pause");
    await page.waitForFunction(() => /^Playing/.test(document.getElementById("viewport-play-state")?.textContent || ""));
    await page.click("#viewport-stop");
    try {
      await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Edit", null, { timeout: 30_000 });
    } catch (error) {
      console.log("UAT stop diagnostic:", await page.evaluate(() => ({
        phase: document.getElementById("viewport-play-state")?.textContent,
        source: document.getElementById("viewport-play-source")?.textContent,
        viewport: document.getElementById("viewport-status")?.textContent,
        playCanvases: document.querySelectorAll(".editor-play-canvas").length,
        editCanvasHidden: document.getElementById("editor-viewport")?.hidden,
      })));
      throw error;
    }
    console.log("UAT checkpoint: edit restored");
    await page.waitForTimeout(150);
    const restoredPngBytes = await page.evaluate(() => document.getElementById("editor-viewport").toDataURL("image/png").length);
    assert.ok(restoredPngBytes > 6_000, `restored edit canvas must be non-flat (${restoredPngBytes} encoded chars)`);
    await page.screenshot({ path: "/tmp/limina-play-workflow-restored.png", fullPage: true });

    // Regression: the preserved Edit runtime must support another complete Play/Stop cycle.
    await page.click("#viewport-play");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Playing", null, { timeout: 30_000 });
    await page.click("#viewport-stop");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Edit", null, { timeout: 20_000 });
    console.log("UAT checkpoint: repeated Play/Stop restored Edit");
    assert.deepEqual(pageErrors, [], "Play workflow must not raise page errors");
    for (const path of ["/tmp/limina-play-workflow-playing.png", "/tmp/limina-play-workflow-paused.png", "/tmp/limina-play-workflow-restored.png"]) {
      assert.ok(fs.statSync(path).size > 10_000, `${path} screenshot must contain rendered pixels`);
    }
    console.log(`play_workflow_browser.test OK: real start/pause/external-stale/resume/stop/edit restore; canvas ${restoredPngBytes} chars. Screenshots: /tmp/limina-play-workflow-{playing,paused,restored}.png`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
