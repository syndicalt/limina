const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PNG } = require("../../tools/node_modules/pngjs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");
const { provisionGeneratedWaterUat } = require("./generated_water_self_contained.cjs");

const HYDROLOGY_FIELD = "hydrology-field/v1";
const GENERATED_WATER = "hydrology-water-topology/v1";

function externalUat() {
  const names = ["PLAY_UAT_HOST", "PLAY_UAT_TOKEN", "PLAY_UAT_EDITOR", "PLAY_UAT_DERIVED"];
  const present = names.filter((name) => process.env[name] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== names.length) {
    throw new Error(`external generated-water UAT requires all PLAY_UAT_* values; received ${present.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(names.map((name) => [name, process.env[name]])));
}

function globalArtifact(manifest, artifactType) {
  return manifest?.globalArtifacts?.find((artifact) => artifact.artifactType === artifactType);
}

function canvasSignal(pngBytes) {
  const png = PNG.sync.read(pngBytes);
  const colors = new Set();
  let visible = 0;
  const stride = Math.max(1, Math.floor((png.width * png.height) / 10_000));
  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    if (png.data[offset + 3] > 0 && png.data[offset] + png.data[offset + 1] + png.data[offset + 2] > 12) visible++;
    colors.add(`${png.data[offset] >> 4}:${png.data[offset + 1] >> 4}:${png.data[offset + 2] >> 4}`);
  }
  return { visible, colors: colors.size, samples: Math.ceil((png.width * png.height) / stride) };
}

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  const external = externalUat();
  const owned = external === null ? await provisionGeneratedWaterUat(loaded.chromium, executablePath) : null;
  const environment = external ?? owned.environment;
  const host = environment.PLAY_UAT_HOST;
  const token = environment.PLAY_UAT_TOKEN;
  const editorUrl = environment.PLAY_UAT_EDITOR;
  const derivedUrl = environment.PLAY_UAT_DERIVED;
  if (!/^wss?:\/\/(?:localhost|127\.0\.0\.1):[1-9][0-9]{0,4}\/$/.test(host)
      || !/^[A-Za-z0-9_-]{32,128}$/.test(token)
      || !/^http:\/\/localhost:[1-9][0-9]{0,4}\/$/.test(editorUrl)
      || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(derivedUrl)) {
    throw new Error("PLAY_UAT_* values do not match the generated launcher contract");
  }

  let browser;
  let page;
  const screenshot = "/tmp/limina-generated-water-workflow.png";
  try {
    browser = await loaded.chromium.launch({
      headless: process.env.PLAY_UAT_HEADFUL !== "1",
      executablePath,
      args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    const currentTasks = [];
    const currents = [];
    const fetchedArtifactHashes = new Set();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const url = response.url();
      if (url === new URL("v1/derived/current", derivedUrl).href && response.status() === 200) {
        currentTasks.push(response.json().then((body) => currents.push(body)));
        return;
      }
      const match = url.match(/\/v1\/derived\/manifests\/[0-9a-f]{64}\/artifacts\/([0-9a-f]{64})$/);
      if (match && response.status() === 200) fetchedArtifactHashes.add(`sha256:${match[1]}`);
    });
    const launchUrl = new URL(editorUrl);
    launchUrl.searchParams.set("server", host);
    await page.goto(launchUrl.href, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      window.__liminaGeneratedWaterStatuses = [];
      const status = document.getElementById("viewport-status");
      new MutationObserver(() => window.__liminaGeneratedWaterStatuses.push(status?.textContent || ""))
        .observe(status, { childList: true, subtree: true, characterData: true });
    });
    await page.fill("#auth-token", token);
    await page.click("#connect");
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "connected", null, { timeout: 10_000 });
    await page.waitForFunction(() => window.__liminaGeneratedWaterStatuses?.some((value) => /^derived: r\d+ · sha256:/.test(value)), null, { timeout: 60_000 });
    await Promise.all([...currentTasks]);

    const current = currents.at(-1);
    assert.ok(current?.manifest, "derived current response omitted its manifest");
    const field = globalArtifact(current.manifest, HYDROLOGY_FIELD);
    const water = globalArtifact(current.manifest, GENERATED_WATER);
    assert.ok(field && water,
      `fixture prerequisite failed: current publication must contain ${HYDROLOGY_FIELD} and ${GENERATED_WATER}`);
    assert.match(field.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(water.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(fetchedArtifactHashes.has(field.contentHash), true, "Edit did not fetch the hydrology field artifact");
    assert.equal(fetchedArtifactHashes.has(water.contentHash), true, "Edit did not fetch the generated-water artifact");

    // Install the probe after Edit is active. Isolated Play then exercises a fresh production
    // decode -> detached candidate -> scene mount path without exposing product-only test APIs.
    await page.evaluate(async () => {
      const { THREE } = await import("../vendor/limina-runtime.js");
      const originalAdd = THREE.Object3D.prototype.add;
      const originalRemove = THREE.Object3D.prototype.remove;
      const fragments = new Map();
      const probe = {
        added: [], removed: [], fragments, originalAdd, originalRemove,
        snapshot() {
          return [...fragments.values()].filter((entry) => entry.mesh.parent !== null).map((entry) => ({
            name: entry.mesh.name,
            geometry: entry.mesh.geometry?.uuid,
            material: Array.isArray(entry.mesh.material)
              ? entry.mesh.material.map((material) => material.uuid).join(",")
              : entry.mesh.material?.uuid,
            renders: entry.renders,
            parent: entry.mesh.parent?.name ?? null,
          }));
        },
        async captureWaterDelta() {
          const active = [...fragments.values()].filter((entry) => entry.mesh.parent !== null);
          const rendered = active.find((entry) => entry.renderer && entry.scene && entry.camera);
          if (!rendered) throw new Error("generated-water probe has no rendered production fragment");
          const bounds = new THREE.Box3();
          for (const entry of active) bounds.expandByObject(entry.mesh);
          if (bounds.isEmpty()) throw new Error("generated-water production bounds are empty");
          const center = bounds.getCenter(new THREE.Vector3());
          const size = bounds.getSize(new THREE.Vector3());
          const span = Math.max(size.x, size.z, 8);
          const { renderer, scene, camera } = rendered;
          camera.position.set(center.x, center.y + Math.max(20, span * 1.1), center.z + Math.max(10, span * 0.35));
          camera.near = 0.1;
          camera.far = Math.max(200, span * 5);
          camera.lookAt(center);
          camera.updateProjectionMatrix();
          const canvas = renderer.domElement;
          const scratch = document.createElement("canvas");
          scratch.width = canvas.width;
          scratch.height = canvas.height;
          const context = scratch.getContext("2d", { willReadFrequently: true });
          const capture = () => {
            renderer.render(scene, camera);
            context.clearRect(0, 0, scratch.width, scratch.height);
            context.drawImage(canvas, 0, 0);
            return context.getImageData(0, 0, scratch.width, scratch.height).data.slice();
          };
          const withWater = capture();
          for (const entry of active) entry.mesh.visible = false;
          let withoutWater;
          try { withoutWater = capture(); }
          finally { for (const entry of active) entry.mesh.visible = true; }
          renderer.render(scene, camera);
          await new Promise((resolve) => setTimeout(resolve, 250));
          camera.position.set(center.x, center.y + Math.max(20, span * 1.1), center.z + Math.max(10, span * 0.35));
          camera.lookAt(center);
          const laterWater = capture();
          let changed = 0, totalDelta = 0, temporalChanged = 0, temporalDelta = 0;
          for (let offset = 0; offset < withWater.length; offset += 4) {
            const delta = Math.abs(withWater[offset] - withoutWater[offset])
              + Math.abs(withWater[offset + 1] - withoutWater[offset + 1])
              + Math.abs(withWater[offset + 2] - withoutWater[offset + 2]);
            totalDelta += delta;
            if (delta >= 8) changed++;
            const motion = Math.abs(withWater[offset] - laterWater[offset])
              + Math.abs(withWater[offset + 1] - laterWater[offset + 1])
              + Math.abs(withWater[offset + 2] - laterWater[offset + 2]);
            temporalDelta += motion;
            if (motion >= 8) temporalChanged++;
          }
          return { changed, totalDelta, temporalChanged, temporalDelta, width: scratch.width, height: scratch.height };
        },
      };
      const generated = (object) => /^limina:generated-water-(?:basin|reach|waterfall)$/.test(object?.name || "");
      THREE.Object3D.prototype.add = function (...objects) {
        for (const object of objects) if (generated(object)) {
          const entry = { mesh: object, renders: 0 };
          fragments.set(object.uuid, entry);
          probe.added.push(object.uuid);
          const prior = object.onBeforeRender;
          object.onBeforeRender = function (...args) {
            entry.renders++;
            entry.renderer = args[0];
            entry.scene = args[1];
            entry.camera = args[2];
            return prior?.apply(this, args);
          };
        }
        return originalAdd.apply(this, objects);
      };
      THREE.Object3D.prototype.remove = function (...objects) {
        for (const object of objects) if (generated(object)) probe.removed.push(object.uuid);
        return originalRemove.apply(this, objects);
      };
      window.__liminaGeneratedWaterProbe = probe;
    });

    await page.click('[data-quality-tier="performance"]');
    await page.click("#viewport-play");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Playing", null, { timeout: 60_000 });
    await page.waitForFunction(() => {
      const snapshot = window.__liminaGeneratedWaterProbe?.snapshot?.() ?? [];
      return snapshot.length > 0 && snapshot.some((entry) => entry.renders > 0);
    }, null, { timeout: 20_000 });

    const performance = await page.evaluate(() => window.__liminaGeneratedWaterProbe.snapshot());
    assert.ok(performance.length > 0 && performance.length <= 128,
      `generated-water fixture mounted ${performance.length} fragments outside the Performance budget 1-128`);
    assert.ok(performance.every((entry) => entry.parent === "limina:derived-water"),
      `generated-water fragments escaped the derived-water owner: ${JSON.stringify(performance)}`);
    assert.ok(performance.some((entry) => entry.renders > 0), "no generated-water fragment reached the renderer");
    const waterPixels = await page.evaluate(() => window.__liminaGeneratedWaterProbe.captureWaterDelta());
    assert.ok(waterPixels.changed > 200 && waterPixels.totalDelta > 10_000,
      `generated water did not make a material pixel contribution: ${JSON.stringify(waterPixels)}`);
    assert.ok(waterPixels.temporalChanged > 50 && waterPixels.temporalDelta > 2_000,
      `generated water did not visibly animate over time: ${JSON.stringify(waterPixels)}`);

    await page.click('[data-quality-tier="cinematic"]');
    await page.waitForFunction((prior) => {
      const next = window.__liminaGeneratedWaterProbe.snapshot();
      return next.length === prior.length && next.every((entry, index) => entry.material !== prior[index].material);
    }, performance, { timeout: 10_000 });
    const cinematic = await page.evaluate(() => window.__liminaGeneratedWaterProbe.snapshot());
    assert.ok(cinematic.every((entry, index) => entry.geometry !== performance[index].geometry),
      "Cinematic quality did not transactionally rebuild generated-water geometry");

    const pixels = canvasSignal(await page.locator(".editor-play-canvas").screenshot());
    assert.ok(pixels.visible > pixels.samples * 0.5 && pixels.colors >= 8,
      `generated-water Play canvas is blank or flat: ${JSON.stringify(pixels)}`);
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.ok(fs.statSync(screenshot).size > 10_000, "generated-water workflow screenshot is empty");

    await page.click("#viewport-stop");
    await page.waitForFunction(() => document.getElementById("viewport-play-state")?.textContent === "Edit", null, { timeout: 30_000 });
    const teardown = await page.evaluate(() => ({
      added: [...window.__liminaGeneratedWaterProbe.added],
      removed: [...window.__liminaGeneratedWaterProbe.removed],
    }));
    assert.deepEqual([...new Set(teardown.removed)].sort(), [...new Set(teardown.added)].sort(),
      "Play teardown did not remove every generated-water fragment it mounted");
    assert.deepEqual(pageErrors, [], `generated-water workflow raised page errors: ${pageErrors.join(" | ")}`);
    console.log(`generated_water_workflow_browser.test OK: exact hydrology globals, ${performance.length} Performance fragments, ${waterPixels.changed} water-changed pixels, ${waterPixels.temporalChanged} animated pixels, Cinematic rebuild, bounded teardown; ${screenshot}`);
  } finally {
    await page?.evaluate(async () => {
      const probe = window.__liminaGeneratedWaterProbe;
      if (!probe) return;
      const { THREE } = await import("../vendor/limina-runtime.js");
      THREE.Object3D.prototype.add = probe.originalAdd;
      THREE.Object3D.prototype.remove = probe.originalRemove;
      delete window.__liminaGeneratedWaterProbe;
    }).catch(() => undefined);
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await owned?.cleanup();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
