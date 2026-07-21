const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  const browser = await loaded.chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto((process.env.EDITOR_BASE_URL ?? "http://localhost:5173") + "/", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
      const { createBrowserRenderHost, THREE } = await import("../vendor/limina-runtime.js");
      const parent = document.createElement("div");
      parent.style.cssText = "position:fixed;left:0;top:0;width:640px;height:360px;z-index:9999";
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%";
      parent.appendChild(canvas);
      document.body.appendChild(parent);
      let telemetryCalls = 0;
      const host = createBrowserRenderHost({
        canvas,
        forceWebGL: true,
        initialQuality: "balanced",
        devicePixelRatio: 2,
        qualityOverride: { telemetryIntervalFrames: 1 },
      });
      const otherCanvas = document.createElement("canvas");
      const otherHost = createBrowserRenderHost({ canvas: otherCanvas, forceWebGL: true });
      const hostCacheIsolated = host.gltfCache !== otherHost.gltfCache;
      await otherHost.dispose();
      const concurrent = await Promise.allSettled([
        host.acquireWorld({ width: 640, height: 360, baseline: false }),
        host.acquireWorld({ width: 640, height: 360, baseline: false }),
      ]);
      const concurrentSessions = concurrent.filter((entry) => entry.status === "fulfilled");
      concurrentSessions[0]?.value.dispose();

      const dirty = await host.acquireWorld({ width: 640, height: 360, baseline: false });
      const defaultToneMapping = dirty.renderer.toneMapping;
      dirty.scene.background = new THREE.Color(0x123456);
      dirty.scene.environment = new THREE.Texture();
      dirty.scene.fog = new THREE.Fog(0xffffff, 1, 10);
      dirty.camera.zoom = 3;
      dirty.camera.position.set(99, 98, 97);
      dirty.camera.add(new THREE.Object3D());
      dirty.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      dirty.dispose();
      const clean = await host.acquireWorld({ width: 640, height: 360, baseline: false });
      const stateReset = clean.scene.background === null && clean.scene.environment === null && clean.scene.fog === null
        && clean.camera.zoom === 1 && clean.camera.position.lengthSq() === 0 && clean.camera.children.length === 0
        && clean.renderer.toneMapping === defaultToneMapping;
      parent.style.width = "800px";
      parent.style.height = "450px";
      clean.resize(800, 450);
      const responsiveSurface = canvas.style.width === "100%" && canvas.style.height === "100%"
        && canvas.clientWidth === 800 && canvas.clientHeight === 450
        && canvas.width === 1200 && canvas.height === 675;
      clean.dispose();
      canvas.width = 7;
      canvas.height = 9;
      const repaired = await host.acquireWorld({ width: 800, height: 450, baseline: false });
      const repairedBacking = canvas.width === 1200 && canvas.height === 675;
      repaired.dispose();
      parent.style.width = "640px";
      parent.style.height = "360px";
      let renderer;
      const memory = [];
      for (let index = 0; index < 20; index++) {
        const session = await host.acquireWorld({
          width: 640,
          height: 360,
          baseline: {},
          onTelemetry() {
            telemetryCalls++;
            if (telemetryCalls === 1) throw new Error("injected telemetry consumer failure");
          },
        });
        if (renderer === undefined) renderer = session.renderer;
        if (renderer !== session.renderer || renderer !== host.rendererIdentity()) throw new Error("renderer identity changed between world sessions");
        const geometry = new THREE.BoxGeometry(2, 2, 2);
        const material = new THREE.MeshStandardMaterial({ color: index % 2 ? 0x37b26c : 0xe0a12b, roughness: 0.7 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(0, 1, 0);
        mesh.castShadow = true;
        session.scene.add(mesh);
        session.camera.position.set(5, 4, 7);
        session.camera.lookAt(0, 1, 0);
        session.render(() => session.renderer.render(session.scene, session.camera));
        session.dispose();
        memory.push({ ...session.renderer.info.memory });
      }
      const finalSession = await host.acquireWorld({ width: 640, height: 360, baseline: {} });
      const finalMesh = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 2.4, 2.4),
        new THREE.MeshStandardMaterial({ color: 0xe0a12b, roughness: 0.55 }),
      );
      finalMesh.position.set(0, 1.2, 0);
      finalMesh.castShadow = true;
      finalSession.scene.add(finalMesh);
      finalSession.camera.position.set(5, 4, 7);
      finalSession.camera.lookAt(0, 1, 0);
      finalSession.render(() => finalSession.renderer.render(finalSession.scene, finalSession.camera));
      const finalMemory = finalSession.telemetry().memory;
      const pngLength = canvas.toDataURL("image/png").length;
      const scratch = document.createElement("canvas");
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      scratch.style.cssText = canvas.style.cssText;
      scratch.style.zIndex = "10000";
      const context = scratch.getContext("2d", { willReadFrequently: true });
      context.drawImage(canvas, 0, 0);
      document.body.appendChild(scratch);
      const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
      let darkest = 255;
      let lightest = 0;
      let coloredSamples = 0;
      for (let index = 0; index < pixels.length; index += 64) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        darkest = Math.min(darkest, red, green, blue);
        lightest = Math.max(lightest, red, green, blue);
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 12) coloredSamples++;
      }
      const stableRenderer = finalSession.renderer === renderer;
      globalThis.__liminaRenderLifecycle = { host, finalSession };
      return {
        memory, finalMemory, pngLength, stableRenderer, darkest, lightest, coloredSamples, telemetryCalls,
        concurrentFulfilled: concurrentSessions.length,
        concurrentRejected: concurrent.filter((entry) => entry.status === "rejected").length,
        stateReset, hostCacheIsolated, responsiveSurface, repairedBacking,
      };
    });

    assert.equal(result.stableRenderer, true, "one host did not preserve renderer identity");
    assert.equal(result.concurrentFulfilled, 1, "concurrent acquisition created multiple world owners");
    assert.equal(result.concurrentRejected, 1, "concurrent acquisition did not reject one contender");
    assert.equal(result.stateReset, true, "scene, camera, or renderer state leaked into the next world");
    assert.equal(result.hostCacheIsolated, true, "two browser hosts shared one GLTF cache");
    assert.equal(result.responsiveSurface, true, "host sizing overrode responsive CSS or produced the wrong DPR backing size");
    assert.equal(result.repairedBacking, true, "host cache failed to repair an externally reset canvas backing size");
    assert.equal(result.telemetryCalls, 20, "external-host session telemetry was dropped or stopped after a consumer exception");
    assert.ok(result.pngLength > 6_000, `render host canvas is blank (${result.pngLength} encoded chars)`);
    assert.ok(result.lightest - result.darkest > 80, `rendered frame has insufficient luminance range (${result.darkest}..${result.lightest})`);
    assert.ok(result.coloredSamples > 250, `rendered frame lacks colored content (${result.coloredSamples} samples)`);
    const warm = result.memory.slice(4);
    for (const key of ["textures", "geometries", "programs", "renderTargets"]) {
      const values = warm.map((sample) => sample[key]);
      const ceiling = values[0];
      assert.ok(values.every((value) => value <= ceiling), `${key} exceeded its post-warm bound ${ceiling}: ${values.join(",")}`);
    }
    assert.deepEqual(pageErrors, [], `render lifecycle raised page errors: ${pageErrors.join(" | ")}`);
    const screenshot = "/tmp/limina-render-lifecycle.png";
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.ok(fs.statSync(screenshot).size > 10_000, "render lifecycle screenshot is empty");
    const rejectedAfterDispose = await page.evaluate(async () => {
      const { host, finalSession } = globalThis.__liminaRenderLifecycle;
      finalSession.dispose();
      await host.dispose();
      try { await host.acquireWorld({ width: 1, height: 1, baseline: false }); }
      catch { return true; }
      return false;
    });
    assert.equal(rejectedAfterDispose, true, "disposed host accepted another world");
    const finalCounters = result.memory[result.memory.length - 1];
    console.log(`render_lifecycle_browser.test OK: one renderer across 21 worlds, bounded counters ${JSON.stringify(finalCounters)}, ${result.coloredSamples} colored samples; ${screenshot}`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
