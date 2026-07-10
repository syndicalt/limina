const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PNG } = require("../../tools/node_modules/pngjs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

function requiredUat(name) {
  const value = process.env[name];
  if (!value) { console.log(`SKIP: ${name} is required; launch the editor and pass its banner values`); process.exit(2); }
  return value;
}

function artifactRequestUpperBound(manifest) {
  const globals = Array.isArray(manifest?.globalArtifacts) ? manifest.globalArtifacts.length : 0;
  const chunks = Array.isArray(manifest?.chunks) ? Math.min(225, manifest.chunks.length) : 0;
  return globals + chunks;
}

(async () => {
  const host = requiredUat("PLAY_UAT_HOST");
  const token = requiredUat("PLAY_UAT_TOKEN");
  const editorUrl = requiredUat("PLAY_UAT_EDITOR");
  const derivedUrl = requiredUat("PLAY_UAT_DERIVED");
  if (!/^wss?:\/\/(?:localhost|127\.0\.0\.1):[1-9][0-9]{0,4}\/$/.test(host)
      || !/^[A-Za-z0-9_-]{32,128}$/.test(token)
      || !/^http:\/\/localhost:[1-9][0-9]{0,4}\/$/.test(editorUrl)
      || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(derivedUrl)) {
    throw new Error("PLAY_UAT_* values do not match the generated launcher contract");
  }
  const mobile = process.env.PLAY_UAT_MOBILE === "1";
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const suffix = mobile ? "-mobile" : "";
  const screenshots = {
    playing: `/tmp/limina-play-workflow-playing${suffix}.png`,
    paused: `/tmp/limina-play-workflow-paused${suffix}.png`,
    restored: `/tmp/limina-play-workflow-restored${suffix}.png`,
  };
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
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  const derivedCurrents = [];
  const currentResponseTasks = [];
  let derivedArtifacts = 0;
  let cleanupEntity;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (url === new URL("v1/derived/current", derivedUrl).href && (response.status() === 200 || response.status() === 304)) {
      currentResponseTasks.push(Promise.all([
        response.allHeaders(),
        response.status() === 200 ? response.json().catch(() => undefined) : Promise.resolve(undefined),
      ]).then(([headers, body]) => { derivedCurrents.push({ headers, body }); }));
    } else if (/\/v1\/derived\/manifests\/[0-9a-f]{64}\/artifacts\/[0-9a-f]{64}$/.test(url) && response.status() === 200) {
      derivedArtifacts++;
    }
  });
  const settleCurrentResponses = async () => { await Promise.all([...currentResponseTasks]); };
  const canvasSignal = async (selector) => {
    const png = PNG.sync.read(await page.locator(selector).screenshot());
    const pixels = png.data;
    const colors = new Set();
    let visible = 0;
    const stride = Math.max(1, Math.floor((pixels.length / 4) / 10_000));
    let sampled = 0;
    for (let pixel = 0; pixel < pixels.length / 4; pixel += stride) {
      const index = pixel * 4;
      if (pixels[index + 3] > 0 && pixels[index] + pixels[index + 1] + pixels[index + 2] > 12) visible++;
      colors.add(`${pixels[index] >> 4}:${pixels[index + 1] >> 4}:${pixels[index + 2] >> 4}`);
      sampled++;
    }
    return { visible, colors: colors.size, total: sampled };
  };
  try {
    const launchUrl = new URL(editorUrl);
    launchUrl.searchParams.set("server", host);
    await page.goto(launchUrl.href, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      window.__liminaUatViewportStatuses = [];
      const status = document.getElementById("viewport-status");
      new MutationObserver(() => window.__liminaUatViewportStatuses.push(status?.textContent || ""))
        .observe(status, { childList: true, subtree: true, characterData: true });
    });
    await page.fill("#auth-token", token);
    await page.click("#connect");
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "connected", null, { timeout: 10_000 });
    console.log("UAT checkpoint: connected");
    await page.waitForFunction(() => /live|following/.test(document.getElementById("viewport-status")?.textContent || ""), null, { timeout: 20_000 });
    console.log("UAT checkpoint: edit runtime ready");
    await page.waitForFunction(() => window.__liminaUatViewportStatuses?.some((value) => /^derived: r\d+ · sha256:/.test(value)), null, { timeout: 30_000 });
    await settleCurrentResponses();
    const editDerivedStatus = await page.evaluate(() => window.__liminaUatViewportStatuses.findLast((value) => /^derived: r\d+ · sha256:/.test(value)));
    assert.match(editDerivedStatus, /^derived: r\d+ · sha256:[0-9a-f]{8}…$/);
    assert.ok(derivedCurrents.length > 0, "Edit activation must fetch an authenticated current publication");
    const editCurrent = derivedCurrents.at(-1);
    const editIdentity = editCurrent.headers;
    assert.match(editIdentity["x-limina-manifest-hash"], /^sha256:[0-9a-f]{64}$/);
    const editArtifactBound = artifactRequestUpperBound(derivedCurrents.findLast((entry) => entry.body)?.body?.manifest);
    assert.equal(derivedArtifacts > 0 && derivedArtifacts <= editArtifactBound, true,
      `Edit loaded ${derivedArtifacts} artifacts; expected 1-${editArtifactBound}`);
    console.log("UAT checkpoint: exact derived Edit revision activated", editIdentity["x-limina-revision"]);
    const preflightHead = await page.evaluate(async () => {
      const { refreshAuthoringHead } = await import("./src/write-client.js");
      return refreshAuthoringHead();
    });
    console.log("UAT checkpoint: authoritative head", preflightHead.revision);
    assert.equal(editIdentity["x-limina-revision"], String(preflightHead.revision));
    assert.equal(editIdentity["x-limina-head-hash"], preflightHead.headHash);

    const playCurrentStart = derivedCurrents.length;
    const playArtifactStart = derivedArtifacts;
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
    await settleCurrentResponses();
    assert.ok(derivedCurrents.length > playCurrentStart, "pinned Play did not fetch the exact current publication");
    const playIdentity = derivedCurrents.at(-1).headers;
    assert.equal(playIdentity["x-limina-manifest-hash"], editIdentity["x-limina-manifest-hash"], "Play manifest drifted from Edit");
    assert.equal(playIdentity["x-limina-revision"], editIdentity["x-limina-revision"], "Play revision drifted from Edit");
    assert.equal(playIdentity["x-limina-head-hash"], editIdentity["x-limina-head-hash"], "Play head drifted from Edit");
    assert.ok(derivedArtifacts - playArtifactStart <= editArtifactBound,
      `Play loaded ${derivedArtifacts - playArtifactStart} artifacts; exceeded chunk+global bound ${editArtifactBound}`);
    const playingSource = await page.textContent("#viewport-play-source");
    assert.match(playingSource, /remnants-of-aethon-grey-field · r\d+ · sha256:/, "Playing must show captured project/revision/head identity");
    const playingPixels = await canvasSignal(".editor-play-canvas");
    assert.ok(playingPixels.visible > playingPixels.total * 0.5 && playingPixels.colors >= 2,
      `Play canvas is blank/flat: ${JSON.stringify(playingPixels)}`);
    await page.screenshot({ path: screenshots.playing, fullPage: true });

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
    await page.screenshot({ path: screenshots.paused, fullPage: true });

    cleanupEntity = await page.evaluate(async ({ host, token }) => {
      const { McpClient } = await import("./src/mcp-client.js");
      const external = new McpClient(host, token);
      await external.connect();
      await external.initialize("play_uat_external", "ses_play_uat_external", "builder.readWrite");
      try {
        return (await external.callTool("scene.createEntity", { position: [6, 0.5, 2], shape: "box", color: 0x37b26c })).entity;
      } finally { external.close(); }
    }, { host, token });
    await page.waitForFunction(() => /stale/.test(document.getElementById("viewport-play-state")?.textContent || ""), null, { timeout: 10_000 });
    console.log("UAT checkpoint: external edit buffered while Play was paused");

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
    const restoredPixels = await canvasSignal("#editor-viewport");
    assert.ok(restoredPixels.visible > restoredPixels.total * 0.5 && restoredPixels.colors >= 2,
      `restored Edit canvas is blank/flat: ${JSON.stringify(restoredPixels)}`);
    await page.screenshot({ path: screenshots.restored, fullPage: true });

    // Regression: the preserved Edit runtime must support another complete Play/Stop cycle.
    await page.click("#viewport-play");
    try {
      await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Playing", null, { timeout: 30_000 });
    } catch (error) {
      console.log("UAT repeated-start diagnostic:", await page.evaluate(() => ({
        phase: document.getElementById("viewport-play-state")?.textContent,
        source: document.getElementById("viewport-play-source")?.textContent,
        viewport: document.getElementById("viewport-status")?.textContent,
        progress: document.body.dataset.playProgress,
        playDisabled: document.getElementById("viewport-play")?.disabled,
      })));
      console.log("UAT repeated-start page errors:", pageErrors);
      throw error;
    }
    await page.click("#viewport-stop");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Edit", null, { timeout: 20_000 });
    console.log("UAT checkpoint: repeated Play/Stop restored Edit");
    assert.deepEqual(pageErrors, [], "Play workflow must not raise page errors");
    for (const path of Object.values(screenshots)) {
      assert.ok(fs.statSync(path).size > 10_000, `${path} screenshot must contain rendered pixels`);
    }
    console.log(`play_workflow_browser.test OK (${mobile ? "mobile" : "desktop"}): exact derived Edit/pinned Play, start/pause/resume/stop/Edit restore, bounded artifacts, composited pixels, repeated cycle; canvas ${restoredPngBytes} chars. Screenshots: ${Object.values(screenshots).join(", ")}`);
  } finally {
    let cleanupFailure;
    if (cleanupEntity) {
      await page.evaluate(async ({ host, token, entity }) => {
        const { McpClient } = await import("./src/mcp-client.js");
        const external = new McpClient(host, token);
        await external.connect();
        await external.initialize("play_uat_cleanup", "ses_play_uat_cleanup", "builder.readWrite");
        try { await external.callTool("scene.destroyEntity", { entity }); }
        finally { external.close(); }
      }, { host, token, entity: cleanupEntity }).catch((error) => { cleanupFailure = error; });
    }
    await page.close();
    await browser.close();
    if (cleanupFailure) throw new Error(`UAT demo-entity cleanup failed: ${cleanupFailure.message}`);
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
