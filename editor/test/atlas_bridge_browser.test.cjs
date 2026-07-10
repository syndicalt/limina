const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");
const { artifactPath } = require("./artifacts.cjs");

const CHROME = chromeExecutable();
const BASE_URL = process.env.EDITOR_BASE_URL || "http://localhost:5173";
const EDITOR_URL = process.env.LIMINA_EDITOR_URL || "ws://127.0.0.1:8787/";
const TOKEN = process.env.LIMINA_EDITOR_TOKEN;

function fail(message) { console.error("FAIL: " + message); process.exit(1); }

(async () => {
  if (!TOKEN) skip("LIMINA_EDITOR_TOKEN is required for live Atlas bridge UAT");
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  requireChromeBinary(CHROME);
  const { EditorBridgeClient, editorClientConfigFromEnvironment } = await import("../../tools/bridge/editor-client.mjs");
  const authority = new EditorBridgeClient(editorClientConfigFromEnvironment({
    LIMINA_EDITOR_URL: EDITOR_URL,
    LIMINA_EDITOR_TOKEN: TOKEN,
  }, {
    agentId: "atlas-bridge-browser-uat",
    sessionId: "atlas-bridge-browser-uat",
    profile: "builder.readWrite",
  }));
  const before = await authority.callTool("authoring.sourceSnapshot", {});
  const browser = await loaded.chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText;
    if (request.method() === "GET" && /\/v1\/derived\/current$/.test(request.url()) && error === "net::ERR_ABORTED") return;
    failedRequests.push(`${request.method()} ${request.url()}: ${error}`);
  });
  try {
    const url = `${BASE_URL}/?server=${encodeURIComponent(EDITOR_URL)}`;
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    if (!response?.ok()) fail(`editor HTTP load failed: ${response?.status()}`);
    await page.locator("#auth-token").fill(TOKEN);
    await page.locator("#connect").click();
    await page.locator("#status-text").filter({ hasText: "connected" }).waitFor({ timeout: 15_000 });
    await page.waitForFunction(
      () => !document.getElementById("viewport-navigation-goto-toggle")?.disabled,
      null,
      { timeout: 30_000 },
    );
    await page.locator("#viewport-atlas-toggle").click();
    await page.locator("#viewport-atlas").waitFor({ state: "visible", timeout: 5_000 });
    const atlasFrameElement = page.locator("#viewport-atlas-frame");
    await atlasFrameElement.waitFor({ state: "visible" });
    const atlasFrame = page.frames().find((frame) => /\/atlas\//.test(frame.url()))
      ?? await new Promise((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const poll = () => {
          const frame = page.frames().find((candidate) => /\/atlas\//.test(candidate.url()));
          if (frame) resolve(frame);
          else if (Date.now() >= deadline) reject(new Error("Atlas iframe did not load"));
          else setTimeout(poll, 50);
        };
        poll();
      });
    await atlasFrame.locator("#map-svg").waitFor({ state: "visible", timeout: 15_000 });

    const isolation = await page.evaluate(() => ({ top: crossOriginIsolated, frameSrc: document.getElementById("viewport-atlas-frame")?.src }));
    const embedded = await atlasFrame.evaluate(() => ({
      isolated: crossOriginIsolated,
      topbar: getComputedStyle(document.querySelector(".topbar")).display,
      bodyClass: document.body.className,
    }));
    if (!isolation.top || !embedded.isolated || embedded.topbar !== "none" || !embedded.bodyClass.includes("embedded-atlas")) {
      fail(`Atlas isolation/embed contract failed: ${JSON.stringify({ isolation, embedded })}`);
    }

    const atlasPanel = page.locator("#viewport-atlas");
    const splitter = page.locator("#viewport-atlas-splitter");
    const initialLayout = await page.evaluate(() => {
      const panel = document.getElementById("viewport-atlas").getBoundingClientRect();
      const canvas = document.getElementById("editor-viewport").getBoundingClientRect();
      return { panelWidth: panel.width, canvasWidth: canvas.width, frameSrc: document.getElementById("viewport-atlas-frame").src };
    });
    const splitterBox = await splitter.boundingBox();
    if (!splitterBox) fail("Atlas splitter is not visible in docked mode");
    await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(splitterBox.x + 96, splitterBox.y + 100, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const resizedLayout = await page.evaluate(() => {
      const panel = document.getElementById("viewport-atlas").getBoundingClientRect();
      const canvas = document.getElementById("editor-viewport");
      const rect = canvas.getBoundingClientRect();
      return {
        panelWidth: panel.width,
        canvasWidth: rect.width,
        cssAspect: rect.width / rect.height,
        bufferAspect: canvas.width / canvas.height,
        ariaValue: Number(document.getElementById("viewport-atlas-splitter").getAttribute("aria-valuenow")),
      };
    });
    if (resizedLayout.panelWidth > initialLayout.panelWidth - 70
        || resizedLayout.canvasWidth < initialLayout.canvasWidth + 70
        || Math.abs(resizedLayout.cssAspect - resizedLayout.bufferAspect) > 0.02
        || Math.abs(resizedLayout.ariaValue - resizedLayout.panelWidth) > 2) {
      fail(`Atlas pointer resize did not preserve renderer layout: ${JSON.stringify({ initialLayout, resizedLayout })}`);
    }
    await splitter.focus();
    await splitter.press("ArrowRight");
    const keyboardWidth = (await atlasPanel.boundingBox())?.width;
    if (!keyboardWidth || keyboardWidth < resizedLayout.panelWidth + 10) fail("Atlas keyboard resize did not grow the dock");

    let dockWidth = keyboardWidth;
    await page.locator("#viewport-atlas-maximize").click();
    const maximized = await page.evaluate(() => {
      const panel = document.getElementById("viewport-atlas").getBoundingClientRect();
      const body = document.getElementById("viewport-body").getBoundingClientRect();
      return { mode: document.getElementById("viewport-atlas").dataset.workspaceMode, panel, body,
        pressed: document.getElementById("viewport-atlas-maximize").getAttribute("aria-pressed"),
        frameSrc: document.getElementById("viewport-atlas-frame").src };
    });
    if (maximized.mode !== "maximized" || maximized.pressed !== "true"
        || Math.abs(maximized.panel.left - maximized.body.left) > 2
        || Math.abs(maximized.panel.right - maximized.body.right) > 2
        || Math.abs(maximized.panel.bottom - maximized.body.bottom) > 2
        || maximized.frameSrc !== initialLayout.frameSrc) {
      fail(`Atlas maximize contract failed: ${JSON.stringify(maximized)}`);
    }
    await page.locator("#viewport-atlas-maximize").click();
    const restoredWidth = (await atlasPanel.boundingBox())?.width;
    if (!restoredWidth || Math.abs(restoredWidth - dockWidth) > 2) fail(`Atlas restore lost dock width: ${restoredWidth} vs ${dockWidth}`);

    await page.locator("#viewport-play").click();
    await page.locator("#viewport-play-state").filter({ hasText: "Playing" }).waitFor({ timeout: 30_000 });
    const playLayout = await page.evaluate(() => {
      const play = document.querySelector(".editor-play-canvas");
      const atlas = document.getElementById("viewport-atlas");
      const playRect = play.getBoundingClientRect();
      const atlasRect = atlas.getBoundingClientRect();
      return {
        playRight: playRect.right,
        atlasLeft: atlasRect.left,
        cssAspect: playRect.width / playRect.height,
        bufferAspect: play.width / play.height,
        children: [...document.getElementById("viewport-body").children].map((node) => node.id || node.className),
      };
    });
    if (playLayout.playRight > playLayout.atlasLeft + 2
        || Math.abs(playLayout.cssAspect - playLayout.bufferAspect) > 0.02
        || playLayout.children.indexOf("editor-play-canvas") > playLayout.children.indexOf("viewport-atlas")) {
      fail(`Play canvas did not remain left of the Atlas dock: ${JSON.stringify(playLayout)}`);
    }
    await splitter.focus();
    await splitter.press("ArrowRight");
    await page.waitForTimeout(200);
    dockWidth = (await atlasPanel.boundingBox())?.width ?? dockWidth;
    const resizedPlayAspect = await page.evaluate(() => {
      const play = document.querySelector(".editor-play-canvas");
      const rect = play.getBoundingClientRect();
      return { css: rect.width / rect.height, buffer: play.width / play.height };
    });
    if (Math.abs(resizedPlayAspect.css - resizedPlayAspect.buffer) > 0.02) {
      fail(`Play renderer did not follow Atlas resize: ${JSON.stringify(resizedPlayAspect)}`);
    }
    await page.locator("#viewport-stop").click();
    await page.locator("#viewport-play-state").filter({ hasText: "Edit" }).waitFor({ timeout: 30_000 });

    const entityRows = page.locator(".outliner-row[data-entity-id]");
    await entityRows.first().waitFor({ state: "visible", timeout: 20_000 });
    let revealed = false;
    for (let index = 0; index < Math.min(await entityRows.count(), 24); index++) {
      await entityRows.nth(index).click();
      await page.waitForTimeout(100);
      if (await atlasFrame.locator(".bridge-reveal").count() > 0) { revealed = true; break; }
    }
    if (!revealed) fail(`no visible outliner entity resolved into the live viewport; Atlas status=${await page.locator("#viewport-atlas-status").textContent()}`);

    const map = atlasFrame.locator("#map-svg");
    const box = await map.boundingBox();
    if (!box || box.width < 300 || box.height < 300) fail(`Atlas map is not usable: ${JSON.stringify(box)}`);
    await map.dblclick({ position: { x: box.width * 0.52, y: box.height * 0.52 } });
    await page.locator("#viewport-atlas-status").filter({ hasText: /^focused / }).waitFor({ timeout: 45_000 });
    await page.locator("#viewport-navigation-views-toggle").click();
    await page.locator("#viewport-navigation-recents").filter({ hasText: "Map coordinate" }).waitFor({ timeout: 5_000 });

    const after = await authority.callTool("authoring.sourceSnapshot", {});
    if (after.head.headHash !== before.head.headHash || after.head.revision !== before.head.revision) {
      fail(`navigation mutated authority: before=${before.head.revision}/${before.head.headHash} after=${after.head.revision}/${after.head.headHash}`);
    }

    await page.screenshot({ path: artifactPath("atlas_bridge_desktop.png"), fullPage: true });

    const persistedPage = await context.newPage();
    try {
      await persistedPage.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await persistedPage.locator("#viewport-atlas").waitFor({ state: "visible", timeout: 10_000 });
      const persisted = await persistedPage.evaluate(() => ({
        width: document.getElementById("viewport-atlas").getBoundingClientRect().width,
        mode: document.getElementById("viewport-atlas").dataset.workspaceMode,
      }));
      if (persisted.mode !== "docked" || Math.abs(persisted.width - dockWidth) > 2) {
        fail(`Atlas workspace layout did not persist: ${JSON.stringify({ persisted, dockWidth })}`);
      }
    } finally { await persistedPage.close(); }

    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForFunction(() => document.getElementById("viewport-atlas")?.dataset.workspaceMode === "compact");
    const intermediate = await page.evaluate(() => {
      const panel = document.getElementById("viewport-atlas").getBoundingClientRect();
      const stage = document.querySelector(".stage").getBoundingClientRect();
      return { panel, stage, width: innerWidth };
    });
    if (intermediate.panel.width < 700 || intermediate.panel.left < intermediate.stage.left - 2
        || intermediate.panel.right > intermediate.stage.right + 2) {
      fail(`intermediate-width compact Atlas is unusable: ${JSON.stringify(intermediate)}`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const panel = document.getElementById("viewport-atlas").getBoundingClientRect();
      return {
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        width: innerWidth, height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        mode: document.getElementById("viewport-atlas").dataset.workspaceMode,
        splitterDisplay: getComputedStyle(document.getElementById("viewport-atlas-splitter")).display,
      };
    });
    if (mobile.panel.left < 0 || mobile.panel.right > mobile.width
        || mobile.panel.top < 0 || mobile.panel.bottom > mobile.height || mobile.panel.right - mobile.panel.left < 360
        || mobile.scrollWidth > mobile.width || mobile.mode !== "compact" || mobile.splitterDisplay !== "none") {
      fail(`mobile Atlas escaped the viewport: ${JSON.stringify(mobile)}`);
    }
    await page.screenshot({ path: artifactPath("atlas_bridge_mobile.png"), fullPage: true });
    if (pageErrors.length > 0) fail("browser errors: " + pageErrors.join(" | "));
    if (failedRequests.length > 0) fail("failed requests: " + failedRequests.join(" | "));
    console.log("atlas_bridge_browser.test OK: isolated dock, Edit/Play resize, maximize/restore, persistence, reverse reveal, exact focus, compact layouts, authority unchanged");
  } finally {
    authority.close();
    await context.close();
    await browser.close();
  }
})().catch((error) => fail(error?.stack ?? error?.message ?? String(error)));
