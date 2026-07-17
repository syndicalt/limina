const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

(async () => {
  const { worldMapContentHash } = await import("../../js/src/world/worldmap-hash.mjs");
  const map = {
    version: 1,
    id: "browser-water-foundation",
    unitsPerMeter: 1,
    origin: [0, 0],
    extent: { w: 40, h: 40 },
    seaLevel: 0,
    land: [{ points: [[0, 0], [40, 0], [40, 40], [0, 40]] }],
    relief: [],
    biomes: [],
    waterways: [{
      points: [[2, 3], [14, 2], [26, 3], [38, 2]],
      widthM: 3,
      widths: [2, 4, 7, 10],
      class: "river",
      order: 4,
    }],
    waterBodies: [{
      id: "ring-lake",
      kind: "lake",
      level: 20,
      footprint: {
        points: [[5, 5], [35, 5], [35, 35], [5, 35]],
        holes: [[[16, 16], [16, 24], [24, 24], [24, 16]]],
      },
      depthZones: [
        { minShoreDistanceM: 0, maxShoreDistanceM: 3, depthM: 1 },
        { minShoreDistanceM: 3, maxShoreDistanceM: 100, depthM: 8 },
      ],
    }],
    routes: [],
    anchors: [],
    provenance: { tool: "design-space", contentHash: "pending" },
  };
  map.provenance.contentHash = worldMapContentHash(map);
  const mapBytes = JSON.stringify(map);
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  const browser = await loaded.chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/assets/maps/browser-water.worldmap.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: mapBytes,
  }));
  try {
    await page.goto((process.env.EDITOR_BASE_URL ?? "http://localhost:5173") + "/", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
      const { createBrowserRenderHost, runLive, THREE } = await import("../vendor/limina-runtime.js");
      const holder = document.createElement("div");
      holder.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px;z-index:9999";
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%";
      holder.appendChild(canvas);
      document.body.appendChild(holder);
      const host = createBrowserRenderHost({ canvas, forceWebGL: true, initialQuality: "performance", devicePixelRatio: 1 });
      const commands = [
        { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
        { kind: "skill", tool: "world.setTerrainSource", input: { kind: "map", mapAssetId: "maps/browser-water.worldmap.json" } },
        { kind: "skill", tool: "world.addMapWater", input: { mapAssetId: "maps/browser-water.worldmap.json" } },
      ];
      const memories = [];
      const tiers = [];
      let liveQuality;
      let lastRuntime;
      const rgbAt = (pixels, width, x, y) => {
        const offset = (Math.max(0, Math.min(canvas.height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
        return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      };
      const sampleWorld = (pixels, value) => {
        const projected = new THREE.Vector3(...value).project(lastRuntime.camera);
        const x = Math.round((projected.x * 0.5 + 0.5) * (canvas.width - 1));
        const y = Math.round((0.5 - projected.y * 0.5) * (canvas.height - 1));
        return rgbAt(pixels, canvas.width, x, y);
      };
      for (let cycle = 0; cycle < 20; cycle++) {
        const tier = cycle < 3 ? ["performance", "balanced", "cinematic"][cycle] : "performance";
        const runtime = await runLive({
          canvas, width: 640, height: 480, commands, forceWebGL: true, renderHost: host, quality: tier,
          terrainMountsPerFrame: 64,
          vantage: { pos: [20, 60, 55], yaw: 0, pitch: -0.95, far: 180 },
        });
        if (!runtime) throw new Error(`runLive returned null for ${tier}/${cycle}`);
        lastRuntime = runtime;
        if (runtime.authoringFailures?.length) throw new Error(`authoring failures: ${JSON.stringify(runtime.authoringFailures)}`);
        for (let frame = 0; frame < 20; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
        await runtime.pause();
        runtime.setViewSuspended(true);
        runtime.camera.position.set(20, 80, 20);
        runtime.camera.lookAt(20, 0, 20);
        runtime.camera.near = 0.1;
        runtime.camera.far = 200;
        runtime.camera.updateProjectionMatrix();
        runtime.renderer.render(runtime.scene, runtime.camera);
        const body = runtime.scene.children.find((child) => child.name === "limina:water-body");
        const river = runtime.scene.children.find((child) => child.name === "limina:river");
        const ocean = runtime.scene.children.find((child) => child.name === "limina:water");
        if (!body || !river || !ocean) throw new Error(`missing water mesh in ${tier}/${cycle}`);
        if (cycle === 0) {
          const originalBodyGeometry = body.geometry;
          const originalOceanVertices = ocean.geometry.getAttribute("position").count;
          const originalDepthWidth = body.material.userData.liminaOwnedTextures?.[0]?.image?.width;
          const cinematic = runtime.setRenderQuality("cinematic");
          liveQuality = {
            tier: cinematic.tier,
            bodyRebuilt: body.geometry !== originalBodyGeometry,
            oceanVerticesBefore: originalOceanVertices,
            oceanVerticesAfter: ocean.geometry.getAttribute("position").count,
            depthWidthBefore: originalDepthWidth,
            depthWidthAfter: body.material.userData.liminaOwnedTextures?.[0]?.image?.width,
          };
          runtime.setRenderQuality("performance");
          runtime.renderer.render(runtime.scene, runtime.camera);
        }
        const scratch = document.createElement("canvas");
        scratch.width = canvas.width; scratch.height = canvas.height;
        const context = scratch.getContext("2d", { willReadFrequently: true });
        context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
        let minimum = 255, maximum = 0, colored = 0;
        for (let index = 0; index < pixels.length; index += 64) {
          const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
          minimum = Math.min(minimum, r, g, b); maximum = Math.max(maximum, r, g, b);
          if (Math.max(r, g, b) - Math.min(r, g, b) > 10) colored++;
        }
        const shallow = sampleWorld(pixels, [6, 20, 20]);
        const deep = sampleWorld(pixels, [11, 20, 20]);
        const hole = sampleWorld(pixels, [20, 0, 20]);
        const delta = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        if (cycle < 3) tiers.push({
          tier, minimum, maximum, colored, shallow, deep, hole,
          shallowDeepDelta: delta(shallow, deep), holeDeepDelta: delta(hole, deep),
          bodyDepthWrite: body.material.depthWrite,
          riverDepthWrite: river.material.depthWrite,
          riverClass: river.userData.waterwayClass,
          riverOrder: river.userData.waterwayOrder,
          hasArc: !!river.geometry.getAttribute("waterArcDistance"),
          hasFlow: !!river.geometry.getAttribute("waterFlowDirection"),
        });
        memories.push({ ...runtime.renderer.info.memory });
        if (cycle === 19) {
          lastRuntime = runtime;
          globalThis.__waterProof = { runtime, host, holder };
        } else await runtime.stop();
      }
      return { tiers, memories, liveQuality, pngLength: canvas.toDataURL("image/png").length };
    });
    assert.equal(result.liveQuality.tier, "cinematic", "live water quality switch returned the wrong profile");
    assert.ok(result.liveQuality.bodyRebuilt, "live water quality switch did not rebuild existing body geometry");
    assert.ok(result.liveQuality.oceanVerticesAfter > result.liveQuality.oceanVerticesBefore,
      `live water quality switch did not increase ocean tessellation: ${JSON.stringify(result.liveQuality)}`);
    assert.ok(result.liveQuality.depthWidthAfter > result.liveQuality.depthWidthBefore,
      `live water quality switch did not increase the body depth raster: ${JSON.stringify(result.liveQuality)}`);
    for (const tier of result.tiers) {
      assert.ok(tier.maximum - tier.minimum > 50 && tier.colored > 200, `${tier.tier} water frame is blank/flat: ${JSON.stringify(tier)}`);
      assert.equal(tier.bodyDepthWrite, false, `${tier.tier} body water writes depth`);
      assert.equal(tier.riverDepthWrite, false, `${tier.tier} river water writes depth`);
      assert.equal(tier.riverClass, "river", `${tier.tier} river class was dropped`);
      assert.equal(tier.riverOrder, 4, `${tier.tier} river order was dropped`);
      assert.ok(tier.hasArc && tier.hasFlow, `${tier.tier} river flow attributes are missing`);
      assert.ok(tier.shallowDeepDelta > 4, `${tier.tier} authored depth tint is not visible: ${JSON.stringify(tier)}`);
      assert.ok(tier.holeDeepDelta > 12, `${tier.tier} lake hole is not visually dry: ${JSON.stringify(tier)}`);
    }
    assert.ok(result.pngLength > 8_000, `water canvas is blank (${result.pngLength} chars)`);
    const warm = result.memories.slice(5);
    for (const key of ["textures", "geometries", "programs", "renderTargets"]) {
      const ceiling = Math.max(...warm.slice(0, 3).map((sample) => sample[key]));
      assert.ok(warm.every((sample) => sample[key] <= ceiling), `${key} exceeded post-warm water bound ${ceiling}: ${warm.map((s) => s[key]).join(",")}`);
    }
    assert.deepEqual(pageErrors, [], `water browser render raised page errors: ${pageErrors.join(" | ")}`);
    const screenshot = "/tmp/limina-water-render.png";
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.ok(fs.statSync(screenshot).size > 10_000, "water render screenshot is empty");
    await page.evaluate(async () => {
      const proof = globalThis.__waterProof;
      await proof.runtime.stop();
      await proof.host.dispose();
      proof.holder.remove();
      delete globalThis.__waterProof;
    });
    console.log(`water_render_browser.test OK: all tiers, dry hole/depth tint/flow attributes, 20 bounded lifecycle cycles; ${screenshot}`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
