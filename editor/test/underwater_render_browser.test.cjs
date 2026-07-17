const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  const browser = await loaded.chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto((process.env.EDITOR_BASE_URL ?? "http://localhost:5173") + "/", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
      const { createBrowserRenderHost, THREE, UnderwaterEffect } = await import("../vendor/limina-runtime.js");

      const capture = (canvas) => {
        const scratch = document.createElement("canvas");
        scratch.width = canvas.width;
        scratch.height = canvas.height;
        const context = scratch.getContext("2d", { willReadFrequently: true });
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, scratch.width, scratch.height).data;
      };
      const stats = (pixels) => {
        let red = 0, green = 0, blue = 0, minLum = 255, maxLum = 0;
        const samples = pixels.length / 4;
        for (let index = 0; index < pixels.length; index += 4) {
          const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
          red += r; green += g; blue += b;
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          minLum = Math.min(minLum, lum);
          maxLum = Math.max(maxLum, lum);
        }
        return { red: red / samples, green: green / samples, blue: blue / samples, minLum, maxLum };
      };
      const delta = (left, right) => {
        let total = 0;
        let changed = 0;
        const samples = left.length / 4;
        for (let index = 0; index < left.length; index += 4) {
          const d = Math.abs(left[index] - right[index])
            + Math.abs(left[index + 1] - right[index + 1])
            + Math.abs(left[index + 2] - right[index + 2]);
          total += d / 3;
          if (d > 18) changed++;
        }
        return { mean: total / samples, changedFraction: changed / samples };
      };
      const run = async (tier, forceWebGL, cycles) => {
        const holder = document.createElement("div");
        holder.style.cssText = "display:inline-block;width:480px;height:300px;margin:8px";
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "display:block;width:100%;height:100%";
        holder.appendChild(canvas);
        document.body.appendChild(holder);
        const host = createBrowserRenderHost({
          canvas,
          forceWebGL,
          initialQuality: tier,
          devicePixelRatio: 1,
        });
        const cycleResults = [];
        let backend = "unknown";
        try {
          for (let cycle = 0; cycle < cycles; cycle++) {
            const session = await host.acquireWorld({ width: 480, height: 300, baseline: false });
            const backendName = session.renderer.backend?.constructor?.name || "";
            backend = session.renderer.backend?.isWebGPUBackend || (/WebGPU/i.test(backendName) && !/WebGL/i.test(backendName)) ? "webgpu" : "webgl2";
            const baselineBackground = new THREE.Color(0x91b7cd);
            const baselineFog = new THREE.FogExp2(0xc5d8e2, 0.005);
            session.scene.background = baselineBackground;
            session.scene.fog = baselineFog;
            session.camera.position.set(7, 4.5, 11);
            session.camera.lookAt(0, 1, -7);
            session.camera.far = 120;
            session.camera.updateProjectionMatrix();
            const ambient = new THREE.HemisphereLight(0xddeeff, 0x31443d, 1.8);
            const sun = new THREE.DirectionalLight(0xffe0a0, 3.2);
            sun.position.set(6, 10, 5);
            session.scene.add(ambient, sun);
            const ground = new THREE.Mesh(
              new THREE.PlaneGeometry(50, 70),
              new THREE.MeshStandardMaterial({ color: 0xb48b5d, roughness: 0.85 }),
            );
            ground.rotation.x = -Math.PI / 2;
            ground.position.set(0, -0.2, -14);
            session.scene.add(ground);
            for (let index = 0; index < 7; index++) {
              const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(2.2, 2.2 + index * 0.15, 2.2),
                new THREE.MeshStandardMaterial({ color: index % 2 ? 0xd86a42 : 0xe6c35c, roughness: 0.5 }),
              );
              mesh.position.set((index % 3 - 1) * 3.4, 1.1, -index * 5);
              session.scene.add(mesh);
            }
            const render = () => {
              session.render(() => session.renderer.render(session.scene, session.camera));
            };
            const effect = new UnderwaterEffect(session.scene);
            render();
            const dry = capture(canvas);
            effect.update(true);
            render();
            const wet = capture(canvas);
            const wetStats = stats(wet);
            const dryWet = delta(dry, wet);
            effect.update(false);
            render();
            const surfaced = capture(canvas);
            const restored = delta(dry, surfaced);
            const referencesRestored = session.scene.background === baselineBackground && session.scene.fog === baselineFog;
            effect.update(true);
            effect.dispose();
            const disposeRestored = session.scene.background === baselineBackground && session.scene.fog === baselineFog;
            effect.dispose();
            cycleResults.push({ wetStats, dryWet, restored, referencesRestored, disposeRestored });
            session.dispose();
          }
        } finally {
          await host.dispose();
        }
        return { tier, backend, cycles: cycleResults };
      };

      const webgl = [];
      for (const tier of ["performance", "balanced", "cinematic"]) webgl.push(await run(tier, true, 2));
      let webgpu = null;
      let webgpuFallback = false;
      if (navigator.gpu) {
        const candidate = await run("balanced", false, 2);
        if (candidate.backend === "webgpu") webgpu = candidate;
        else webgpuFallback = true;
      }
      const proofHolder = document.createElement("div");
      proofHolder.style.cssText = "width:640px;height:360px;margin:8px";
      const proofCanvas = document.createElement("canvas");
      proofCanvas.style.cssText = "display:block;width:100%;height:100%";
      proofHolder.appendChild(proofCanvas);
      document.body.appendChild(proofHolder);
      const proofHost = createBrowserRenderHost({ canvas: proofCanvas, forceWebGL: true, initialQuality: "balanced", devicePixelRatio: 1 });
      const proofSession = await proofHost.acquireWorld({ width: 640, height: 360, baseline: false });
      proofSession.scene.background = new THREE.Color(0x91b7cd);
      proofSession.camera.position.set(7, 4.5, 11);
      proofSession.camera.lookAt(0, 1, -7);
      proofSession.scene.add(new THREE.HemisphereLight(0xddeeff, 0x31443d, 1.8));
      const proofSun = new THREE.DirectionalLight(0xffe0a0, 3.2);
      proofSun.position.set(6, 10, 5);
      proofSession.scene.add(proofSun);
      for (let index = 0; index < 7; index++) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(2.2, 2.2 + index * 0.15, 2.2),
          new THREE.MeshStandardMaterial({ color: index % 2 ? 0xd86a42 : 0xe6c35c, roughness: 0.5 }),
        );
        mesh.position.set((index % 3 - 1) * 3.4, 1.1, -index * 5);
        proofSession.scene.add(mesh);
      }
      const proofEffect = new UnderwaterEffect(proofSession.scene);
      proofEffect.update(true);
      proofSession.render(() => proofSession.renderer.render(proofSession.scene, proofSession.camera));
      globalThis.__liminaUnderwaterProof = { proofEffect, proofSession, proofHost, proofHolder };
      return { webgl, webgpu, webgpuFallback, hasNavigatorGpu: !!navigator.gpu };
    });

    for (const tier of result.webgl) {
      assert.equal(tier.backend, "webgl2", `${tier.tier} did not use the mandatory WebGL2 backend`);
      assert.equal(tier.cycles.length, 2, `${tier.tier} did not complete repeated start/stop cycles`);
      for (const [index, cycle] of tier.cycles.entries()) {
        assert.ok(cycle.wetStats.maxLum - cycle.wetStats.minLum > 20,
          `${tier.tier}/${index} underwater frame is blank or flat (${cycle.wetStats.minLum}..${cycle.wetStats.maxLum})`);
        assert.ok(cycle.wetStats.green > cycle.wetStats.red * 1.08 && cycle.wetStats.blue > cycle.wetStats.red * 1.02,
          `${tier.tier}/${index} underwater frame is not bounded teal: ${JSON.stringify(cycle.wetStats)}`);
        assert.ok(cycle.dryWet.mean > 8 && cycle.dryWet.changedFraction > 0.35,
          `${tier.tier}/${index} underwater delta is not significant: ${JSON.stringify(cycle.dryWet)}`);
        assert.ok(cycle.restored.mean < 0.75 && cycle.restored.changedFraction < 0.01,
          `${tier.tier}/${index} surfacing did not restore dry pixels: ${JSON.stringify(cycle.restored)}`);
        assert.equal(cycle.referencesRestored, true, `${tier.tier}/${index} did not restore authored references`);
        assert.equal(cycle.disposeRestored, true, `${tier.tier}/${index} submerged dispose did not restore references`);
      }
    }
    if (result.webgpu) {
      assert.equal(result.webgpu.backend, "webgpu", "WebGPU candidate reported the wrong initialized backend");
      for (const cycle of result.webgpu.cycles) {
        assert.ok(cycle.wetStats.maxLum - cycle.wetStats.minLum > 20, "WebGPU underwater frame is blank");
        assert.ok(cycle.dryWet.mean > 8 && cycle.restored.mean < 1.5, "WebGPU transition/restoration delta failed");
      }
    }
    assert.deepEqual(pageErrors, [], `underwater browser render raised page errors: ${pageErrors.join(" | ")}`);
    const screenshot = "/tmp/limina-underwater-render.png";
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.ok(fs.statSync(screenshot).size > 10_000, "underwater render screenshot is empty");
    await page.evaluate(async () => {
      const proof = globalThis.__liminaUnderwaterProof;
      proof.proofEffect.dispose();
      proof.proofSession.dispose();
      await proof.proofHost.dispose();
      proof.proofHolder.remove();
      delete globalThis.__liminaUnderwaterProof;
    });
    console.log(`underwater_render_browser.test OK: WebGL2 performance/balanced/cinematic x2; WebGPU=${result.webgpu ? "tested" : result.webgpuFallback ? "renderer-fallback" : "unavailable"}; ${screenshot}`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
