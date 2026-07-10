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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const panel = document.getElementById("viewport-atlas").getBoundingClientRect();
      const viewport = document.getElementById("viewport").getBoundingClientRect();
      return {
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom },
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    if (mobile.panel.left < mobile.viewport.left || mobile.panel.right > mobile.viewport.right
        || mobile.panel.top < mobile.viewport.top || mobile.panel.bottom > mobile.viewport.bottom
        || mobile.scrollWidth > mobile.width) {
      fail(`mobile Atlas escaped the viewport: ${JSON.stringify(mobile)}`);
    }
    await page.screenshot({ path: artifactPath("atlas_bridge_mobile.png"), fullPage: true });
    if (pageErrors.length > 0) fail("browser errors: " + pageErrors.join(" | "));
    if (failedRequests.length > 0) fail("failed requests: " + failedRequests.join(" | "));
    console.log("atlas_bridge_browser.test OK: isolated dock, reverse coordinate reveal, exact terrain focus, recents, mobile bounds, authority unchanged");
  } finally {
    authority.close();
    await browser.close();
  }
})().catch((error) => fail(error?.stack ?? error?.message ?? String(error)));
