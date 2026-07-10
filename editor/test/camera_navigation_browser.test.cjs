const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PNG } = require("../../tools/node_modules/pngjs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

function requiredUat(name) {
  const value = process.env[name];
  if (!value) {
    console.log(`SKIP: ${name} is required; launch the editor and pass its banner values`);
    process.exit(2);
  }
  return value;
}

function canvasSignal(bytes) {
  const png = PNG.sync.read(bytes);
  const colors = new Set();
  let opaque = 0;
  const pixels = png.data.length / 4;
  const stride = Math.max(1, Math.floor(pixels / 12_000));
  let sampled = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const index = pixel * 4;
    if (png.data[index + 3] > 0) opaque++;
    colors.add(`${png.data[index] >> 4}:${png.data[index + 1] >> 4}:${png.data[index + 2] >> 4}`);
    sampled++;
  }
  return { colors: colors.size, opaque, sampled };
}

async function canvasBytes(page, selector, path) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.width >= 600 && box.height >= 400, "editor canvas is not interactable");
  return page.screenshot({ path, clip: box, animations: "disabled" });
}

(async () => {
  const host = requiredUat("PLAY_UAT_HOST");
  const token = requiredUat("PLAY_UAT_TOKEN");
  const editorUrl = requiredUat("PLAY_UAT_EDITOR");
  const derivedUrl = requiredUat("PLAY_UAT_DERIVED");
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log(`SKIP: ${loaded.error}`); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);

  const browser = await loaded.chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  let artifactResponses = 0;
  let currentResponses = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (url === new URL("v1/derived/current", derivedUrl).href && [200, 304].includes(response.status())) {
      currentResponses++;
    }
    if (/\/v1\/derived\/manifests\/[0-9a-f]{64}\/artifacts\/[0-9a-f]{64}$/.test(url) && response.status() === 200) {
      artifactResponses++;
    }
  });

  const screenshots = {
    initial: "/tmp/limina-camera-navigation-initial.png",
    panned: "/tmp/limina-camera-navigation-panned.png",
  };
  try {
    const launchUrl = new URL(editorUrl);
    launchUrl.searchParams.set("server", host);
    await page.goto(launchUrl.href, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      window.__liminaCameraUatStatuses = [];
      const status = document.getElementById("viewport-status");
      new MutationObserver(() => window.__liminaCameraUatStatuses.push(status?.textContent || ""))
        .observe(status, { childList: true, subtree: true, characterData: true });
    });
    await page.fill("#auth-token", token);
    await page.click("#connect");
    await page.waitForFunction(
      () => document.getElementById("status-text")?.textContent === "connected",
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => window.__liminaCameraUatStatuses?.some((status) => /^derived: r\d+/.test(status)),
      null,
      { timeout: 30_000 },
    );

    const canvas = page.locator("#editor-viewport");
    const initialBytes = await canvasBytes(page, "#editor-viewport", screenshots.initial);
    const initialSignal = canvasSignal(initialBytes);
    assert.ok(initialSignal.opaque > initialSignal.sampled * 0.99 && initialSignal.colors >= 8,
      `initial editor frame is blank or visually flat: ${JSON.stringify(initialSignal)}`);

    const box = await canvas.boundingBox();
    assert.ok(box && box.width >= 600 && box.height >= 400, "editor canvas is not interactable");
    const artifactsBeforePan = artifactResponses;
    const currentsBeforePan = currentResponses;
    await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.52);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.52, { steps: 30 });
    await page.mouse.up({ button: "right" });

    const deadline = Date.now() + 30_000;
    while (artifactResponses === artifactsBeforePan && Date.now() < deadline) await page.waitForTimeout(100);
    await page.waitForTimeout(500);

    const incrementalArtifacts = artifactResponses - artifactsBeforePan;
    const incrementalCurrents = currentResponses - currentsBeforePan;
    assert.ok(incrementalCurrents >= 1, "derived publication watch stopped while panning");
    assert.ok(incrementalArtifacts >= 1 && incrementalArtifacts <= 225,
      `panning loaded an invalid number of incremental artifacts: ${incrementalArtifacts}`);
    const pannedBytes = await canvasBytes(page, "#editor-viewport", screenshots.panned);
    const pannedSignal = canvasSignal(pannedBytes);
    assert.ok(pannedSignal.opaque > pannedSignal.sampled * 0.99 && pannedSignal.colors >= 8,
      `panned editor frame is blank or visually flat: ${JSON.stringify(pannedSignal)}`);
    assert.deepEqual(pageErrors, [], "camera navigation must not raise page errors");
    for (const path of Object.values(screenshots)) assert.ok(fs.statSync(path).size > 10_000);
    console.log(`camera_navigation_browser.test OK: framed scene ${initialSignal.colors} colors; `
      + `${incrementalCurrents} publication poll(s), ${incrementalArtifacts} bounded pan-triggered artifact load(s); `
      + `screenshots ${Object.values(screenshots).join(", ")}`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => { console.error(`FAIL: ${error.stack}`); process.exit(1); });
