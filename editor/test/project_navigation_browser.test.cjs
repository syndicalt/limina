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

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function canvasSignal(bytes) {
  const png = PNG.sync.read(bytes);
  const colors = new Set();
  let visible = 0;
  const pixels = png.data.length / 4;
  const stride = Math.max(1, Math.floor(pixels / 12_000));
  let sampled = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const index = pixel * 4;
    if (png.data[index + 3] > 0 && png.data[index] + png.data[index + 1] + png.data[index + 2] > 12) visible++;
    colors.add(`${png.data[index] >> 4}:${png.data[index + 1] >> 4}:${png.data[index + 2] >> 4}`);
    sampled++;
  }
  return { visible, colors: colors.size, sampled };
}

(async () => {
  const host = requiredUat("PLAY_UAT_HOST");
  const token = requiredUat("PLAY_UAT_TOKEN");
  const editorUrl = requiredUat("PLAY_UAT_EDITOR");
  const derivedUrl = requiredUat("PLAY_UAT_DERIVED");
  const loaded = loadChromium();
  if (!loaded.chromium) {
    console.log(`SKIP: ${loaded.error}`);
    process.exit(2);
  }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);

  const browser = await loaded.chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  let artifactResponses = 0;
  let currentPublicationSettled = false;
  let resolveCurrentPublication;
  let rejectCurrentPublication;
  const currentPublicationPromise = new Promise((resolve, reject) => {
    resolveCurrentPublication = resolve;
    rejectCurrentPublication = reject;
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (!currentPublicationSettled && /\/v1\/derived\/current$/.test(url) && response.status() === 200) {
      currentPublicationSettled = true;
      void response.json().then(resolveCurrentPublication, rejectCurrentPublication);
    }
    if (/\/v1\/derived\/manifests\/[0-9a-f]{64}\/artifacts\/[0-9a-f]{64}$/.test(url) && response.status() === 200) {
      artifactResponses++;
    }
  });

  const screenshots = {
    flown: "/tmp/limina-project-navigation-flown.png",
    destination: "/tmp/limina-project-navigation-destination.png",
    restored: "/tmp/limina-project-navigation-restored.png",
  };
  const readTarget = async () => {
    await page.click("#viewport-navigation-goto-toggle");
    await page.waitForFunction(() => document.getElementById("viewport-navigation-goto")?.hidden === false);
    return page.evaluate(() => ({
      x: Number(document.getElementById("viewport-navigation-x").value),
      y: Number(document.getElementById("viewport-navigation-y").value),
      z: Number(document.getElementById("viewport-navigation-z").value),
    }));
  };
  const closeGoto = () => page.click("#viewport-navigation-goto-cancel");
  const goTo = async (target) => {
    await page.click("#viewport-navigation-goto-toggle");
    await page.fill("#viewport-navigation-x", String(target.x));
    await page.fill("#viewport-navigation-y", String(target.y));
    await page.fill("#viewport-navigation-z", String(target.z));
    await page.click("#viewport-navigation-goto-submit");
    await page.waitForFunction(
      () =>
        document.getElementById("viewport-navigation-orbit")?.disabled &&
        document.getElementById("viewport-navigation-speed")?.disabled,
    );
    await page.waitForFunction(() => document.getElementById("viewport-navigation-goto")?.hidden === true, null, {
      timeout: 30_000,
    });
  };

  try {
    const launchUrl = new URL(editorUrl);
    launchUrl.searchParams.set("server", host);
    await page.goto(launchUrl.href, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.fill("#auth-token", token);
    await page.click("#connect");
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "connected", null, {
      timeout: 10_000,
    });
    await page.waitForFunction(() => !document.getElementById("viewport-navigation-goto-toggle")?.disabled, null, {
      timeout: 30_000,
    });
    const headBefore = await page.evaluate(async () => {
      const { refreshAuthoringHead } = await import("./src/write-client.js");
      return refreshAuthoringHead();
    });
    let publicationTimer;
    const publication = await Promise.race([
      currentPublicationPromise,
      new Promise((_resolve, reject) => {
        publicationTimer = setTimeout(() => reject(new Error("derived current publication was not observed")), 10_000);
      }),
    ]).finally(() => clearTimeout(publicationTimer));
    assert.ok(
      Array.isArray(publication?.manifest?.chunks) && publication.manifest.chunks.length > 225,
      "project-navigation authority must extend beyond one maximum residency",
    );
    const chunkSizeM = publication.manifest.grid?.chunkSizeM;
    assert.ok(Number.isFinite(chunkSizeM) && chunkSizeM > 0, "derived manifest omitted a valid chunk size");
    console.log(`UAT checkpoint: Edit ready at authoritative r${headBefore.revision}`);

    const initialTarget = await readTarget();
    assert.ok(
      Object.values(initialTarget).every(Number.isFinite),
      `initial target is invalid: ${JSON.stringify(initialTarget)}`,
    );
    await closeGoto();
    const canvas = page.locator("#editor-viewport");

    await page.click("#viewport-navigation-views-toggle");
    await page.fill("#viewport-navigation-bookmark-name", "UAT initial view");
    await page.click("#viewport-navigation-bookmark-save");
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#viewport-navigation-bookmarks [data-navigation-entry]")].some(
        (button) => button.textContent === "UAT initial view",
      ),
    );
    await page.click("#viewport-navigation-views-close");

    // Exercise discontinuous residency before Fly can legitimately prefetch the
    // only edge outside the initial maximum-radius cache. Derive that edge from
    // the current publication instead of assuming a coordinate sign or extent.
    const minTx = Math.min(...publication.manifest.chunks.map(({ tx }) => tx));
    const minTz = Math.min(...publication.manifest.chunks.map(({ tz }) => tz));
    assert.ok(Number.isInteger(minTx) && Number.isInteger(minTz), "derived manifest chunk bounds are invalid");
    const farTarget = {
      x: (minTx + 0.5) * chunkSizeM,
      y: initialTarget.y,
      z: (minTz + 0.5) * chunkSizeM,
    };
    const artifactsBeforeDestination = artifactResponses;
    await goTo(farTarget);
    const destinationArtifacts = artifactResponses - artifactsBeforeDestination;
    assert.ok(
      destinationArtifacts >= 1 && destinationArtifacts <= 225,
      `coordinate destination loaded ${destinationArtifacts} artifacts; expected 1-225`,
    );
    const committedTarget = await readTarget();
    assert.ok(
      distance(farTarget, committedTarget) < 1e-6,
      `coordinate destination committed the wrong target: ${JSON.stringify({ farTarget, committedTarget })}`,
    );
    await closeGoto();
    const destinationBytes = await canvas.screenshot({ path: screenshots.destination });
    const destinationSignal = canvasSignal(destinationBytes);
    assert.ok(
      destinationSignal.visible > destinationSignal.sampled * 0.5 && destinationSignal.colors >= 4,
      `coordinate destination rendered blank/flat: ${JSON.stringify(destinationSignal)}`,
    );
    console.log(`UAT checkpoint: coordinate destination activated with ${destinationArtifacts} artifacts`);

    await page.click("#viewport-navigation-views-toggle");
    await page.click("#viewport-navigation-bookmarks [data-navigation-kind=bookmark]");
    await page.waitForFunction(() => document.getElementById("viewport-navigation-views")?.hidden === true, null, {
      timeout: 30_000,
    });
    const preflightRestoredTarget = await readTarget();
    assert.ok(
      distance(initialTarget, preflightRestoredTarget) < 1e-6,
      `bookmark did not restore the initial target after coordinate activation: ${JSON.stringify({ initialTarget, preflightRestoredTarget })}`,
    );
    await closeGoto();

    await page.click("#viewport-navigation-fly");
    await page.fill("#viewport-navigation-speed", "512");
    await page.press("#viewport-navigation-speed", "Tab");
    assert.notEqual(
      await canvas.evaluate((element) => getComputedStyle(element).cursor),
      "none",
      "Fly hid the cursor before RMB acquired pointer lock",
    );
    const box = await canvas.boundingBox();
    assert.ok(box && box.width >= 600 && box.height >= 400, "editor canvas is not interactable");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.waitForFunction(() => document.pointerLockElement?.id === "editor-viewport");
    assert.equal(
      await page.evaluate(() => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      true,
      "Fly pointer ownership allowed the page context menu",
    );
    await page.keyboard.down("Shift");
    await page.keyboard.down("w");
    await page.waitForTimeout(900);
    await page.keyboard.up("w");
    await page.keyboard.up("Shift");
    await page.mouse.up({ button: "right" });
    await page.waitForFunction(() => document.pointerLockElement === null);
    assert.notEqual(
      await canvas.evaluate((element) => getComputedStyle(element).cursor),
      "none",
      "Fly did not restore the cursor after RMB released pointer lock",
    );
    await page.waitForTimeout(500);

    const flownTarget = await readTarget();
    assert.ok(
      distance(initialTarget, flownTarget) >= 50,
      `Fly did not move the camera materially: ${JSON.stringify({ initialTarget, flownTarget })}`,
    );
    assert.ok(
      Math.abs(initialTarget.y - flownTarget.y) < 1e-6,
      `WASD changed altitude instead of leaving vertical movement to Q/E: ${JSON.stringify({ initialTarget, flownTarget })}`,
    );
    await closeGoto();
    const flownBytes = await canvas.screenshot({ path: screenshots.flown });
    const flownSignal = canvasSignal(flownBytes);
    assert.ok(
      flownSignal.visible > flownSignal.sampled * 0.5 && flownSignal.colors >= 4,
      `Fly destination rendered blank/flat: ${JSON.stringify(flownSignal)}`,
    );
    console.log(`UAT checkpoint: Fly moved ${distance(initialTarget, flownTarget).toFixed(1)}m`);

    await page.click("#viewport-navigation-views-toggle");
    await page.click("#viewport-navigation-bookmarks [data-navigation-kind=bookmark]");
    await page.waitForFunction(() => document.getElementById("viewport-navigation-views")?.hidden === true, null, {
      timeout: 30_000,
    });
    const bookmarkTarget = await readTarget();
    assert.ok(
      distance(initialTarget, bookmarkTarget) < 1e-6,
      `bookmark did not restore the exact initial target: ${JSON.stringify({ initialTarget, bookmarkTarget })}`,
    );
    assert.equal(
      await page.getAttribute("#viewport-navigation-orbit", "aria-checked"),
      "true",
      "recording a bookmark destination overwrote its stored Orbit mode with the global preference",
    );
    await closeGoto();
    console.log("UAT checkpoint: bookmark restored exact target and Orbit mode");

    await page.click("#viewport-navigation-views-toggle");
    assert.ok(
      (await page.locator("#viewport-navigation-recents [data-navigation-entry]").count()) >= 2,
      "successful destinations were not recorded in project recents",
    );
    await page.click("#viewport-navigation-bookmarks [data-navigation-kind=bookmark]");
    await page.waitForFunction(() => document.getElementById("viewport-navigation-views")?.hidden === true, null, {
      timeout: 30_000,
    });

    await page.click("#viewport-play");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Playing", null, {
      timeout: 30_000,
    });
    await page.click("#viewport-stop");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Edit", null, {
      timeout: 30_000,
    });
    const restoredTarget = await readTarget();
    assert.ok(
      distance(initialTarget, restoredTarget) < 1e-6,
      `Play/Stop did not preserve the bookmarked Edit view: ${JSON.stringify({ initialTarget, restoredTarget })}`,
    );
    assert.equal(
      await page.getAttribute("#viewport-navigation-orbit", "aria-checked"),
      "true",
      "Play/Stop did not preserve the bookmarked Edit navigation mode",
    );
    await closeGoto();
    const restoredBytes = await canvas.screenshot({ path: screenshots.restored });
    const restoredSignal = canvasSignal(restoredBytes);
    assert.ok(
      restoredSignal.visible > restoredSignal.sampled * 0.5 && restoredSignal.colors >= 4,
      `restored Edit destination rendered blank/flat: ${JSON.stringify(restoredSignal)}`,
    );
    console.log("UAT checkpoint: Play/Stop restored exact Edit target and mode");

    const headAfter = await page.evaluate(async () => {
      const { refreshAuthoringHead } = await import("./src/write-client.js");
      return refreshAuthoringHead();
    });
    assert.deepEqual(headAfter, headBefore, "camera navigation mutated the authoritative authoring head");
    assert.deepEqual(pageErrors, [], "project navigation raised browser errors");
    for (const path of Object.values(screenshots)) assert.ok(fs.statSync(path).size > 10_000, `${path} is too small`);
    console.log(
      `project_navigation_browser.test OK: Fly moved ${distance(initialTarget, flownTarget).toFixed(1)}m; ` +
        `exact coordinate activation loaded ${destinationArtifacts} bounded artifacts; bookmark and Play/Stop restored ` +
        `the initial view; authoritative head remained r${headBefore.revision}. Screenshots: ${Object.values(screenshots).join(", ")}`,
    );
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(`FAIL: ${error.stack}`);
  process.exit(1);
});
