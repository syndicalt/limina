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
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
      const { createBrowserRenderHost, runLive } = await import("../vendor/limina-runtime.js");
      const parent = document.createElement("div");
      parent.style.cssText = "position:fixed;left:0;top:0;width:640px;height:360px";
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%";
      parent.appendChild(canvas);
      document.body.appendChild(parent);

      const host = createBrowserRenderHost({
        canvas,
        forceWebGL: true,
        initialQuality: "performance",
        devicePixelRatio: 1,
      });
      const statuses = [];
      const makeRuntime = () => runLive({
        canvas,
        width: 640,
        height: 360,
        commands: [{ kind: "physics", op: "op_physics_create_world", args: [-9.81] }],
        forceWebGL: true,
        orbitControls: true,
        renderHost: host,
        quality: "performance",
        onStatus: (phase, detail) => statuses.push({ phase, detail }),
      });
      const acquireAfterRelease = async (label) => {
        const deadline = performance.now() + 10_000;
        let attempts = 0;
        let lastError = "host remained occupied";
        while (performance.now() < deadline) {
          try {
            const session = await host.acquireWorld({ width: 640, height: 360, baseline: false });
            return { session, attempts };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (!/already owns or is acquiring a world session/.test(lastError)) {
              throw new Error(`${label}: unexpected acquisition failure: ${lastError}`);
            }
            attempts++;
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        }
        throw new Error(`${label}: timed out waiting for host release after ${attempts} attempts: ${lastError}`);
      };

      let first;
      let second;
      let recovery;
      try {
        first = await makeRuntime();
        if (first === null || !first.cameraControls) {
          throw new Error(`first live runtime did not start with camera controls: ${JSON.stringify({
            returnedNull: first === null,
            statuses,
          })}`);
        }
        const controls = first.cameraControls;
        const disposeControls = controls.dispose.bind(controls);
        controls.dispose = () => { throw new Error("injected camera-controls dispose failure"); };

        let stopError;
        try {
          await first.stop();
        } catch (error) {
          stopError = {
            name: error?.name,
            message: error instanceof Error ? error.message : String(error),
            aggregate: error instanceof AggregateError,
            causes: error instanceof AggregateError
              ? error.errors.map((cause) => cause instanceof Error ? cause.message : String(cause))
              : [],
          };
        }
        disposeControls();
        if (stopError === undefined) throw new Error("faulted stop unexpectedly resolved");

        recovery = await host.acquireWorld({ width: 640, height: 360, baseline: false });
        const recoveredAfterStopFault = recovery.renderer === host.rendererIdentity();
        recovery.dispose();
        recovery = undefined;

        second = await makeRuntime();
        if (second === null || typeof second.worker.onerror !== "function") {
          throw new Error("second live runtime did not expose a worker error handler");
        }
        second.worker.onerror({ message: "injected post-ready worker failure" });
        const workerRecovery = await acquireAfterRelease("worker fatal teardown");
        recovery = workerRecovery.session;
        const recoveredAfterWorkerFatal = recovery.renderer === host.rendererIdentity();
        recovery.dispose();
        recovery = undefined;
        await second.stop();

        return {
          stopError,
          recoveredAfterStopFault,
          recoveredAfterWorkerFatal,
          workerReleasePolls: workerRecovery.attempts,
          workerErrorReported: statuses.some(({ phase, detail }) =>
            phase === "error" && /injected post-ready worker failure/.test(detail || "")
          ),
        };
      } finally {
        recovery?.dispose();
        await first?.stop().catch(() => {});
        await second?.stop().catch(() => {});
        await host.dispose();
        parent.remove();
      }
    });

    assert.equal(result.stopError.aggregate, true, `stop must reject with AggregateError, got ${result.stopError.name}`);
    assert.match(result.stopError.message, /live runtime teardown failed in 1 step/);
    assert.deepEqual(result.stopError.causes, ["injected camera-controls dispose failure"]);
    assert.equal(result.recoveredAfterStopFault, true, "camera-controls cleanup failure retained host ownership");
    assert.equal(result.workerErrorReported, true, "post-ready worker error was not reported to the live status sink");
    assert.equal(result.recoveredAfterWorkerFatal, true, "worker-fatal teardown retained host ownership");
    assert.deepEqual(pageErrors, [], `runLive teardown raised page errors: ${pageErrors.join(" | ")}`);
    console.log(
      `run_live_teardown_browser.test OK: AggregateError preserved, external host reused after cleanup fault and worker fatal (${result.workerReleasePolls} release polls)`,
    );
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
