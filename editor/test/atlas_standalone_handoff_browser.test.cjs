const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");

const CHROME = chromeExecutable();
const BASE_URL = process.env.EDITOR_BASE_URL || "http://localhost:5173";
const ATLAS_URL = process.env.LIMINA_ATLAS_URL || "http://127.0.0.1:4321/";
const EDITOR_URL = process.env.LIMINA_EDITOR_URL || "ws://127.0.0.1:8787/";
const TOKEN = process.env.LIMINA_EDITOR_TOKEN;
const EXPECTED_HANDOFF_SERVER = `ws://localhost:${new URL(EDITOR_URL).port}/`;

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

(async () => {
  if (!TOKEN) skip("LIMINA_EDITOR_TOKEN is required for standalone Atlas handoff UAT");
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  requireChromeBinary(CHROME);
  const { EditorBridgeClient, editorClientConfigFromEnvironment } =
    await import("../../tools/bridge/editor-client.mjs");
  const authority = new EditorBridgeClient(
    editorClientConfigFromEnvironment(
      {
        LIMINA_EDITOR_URL: EDITOR_URL,
        LIMINA_EDITOR_TOKEN: TOKEN,
      },
      {
        agentId: "atlas-standalone-handoff-uat",
        sessionId: "atlas-standalone-handoff-uat",
        profile: "builder.readWrite",
      },
    ),
  );
  const before = await authority.callTool("authoring.sourceSnapshot", {});
  const browser = await loaded.chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const atlas = await context.newPage();
  try {
    const response = await atlas.goto(ATLAS_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
    if (!response?.ok()) fail(`standalone Atlas HTTP load failed: ${response?.status()}`);
    await atlas.locator("#open-editor").waitFor({ state: "visible", timeout: 10_000 });
    await atlas.waitForFunction(() => document.getElementById("projname")?.textContent !== "Design Space", null, {
      timeout: 15_000,
    });
    const popupPromise = context.waitForEvent("page", { timeout: 10_000 });
    await atlas.locator("#open-editor").click();
    const editor = await popupPromise;
    await editor.waitForURL((url) => url.origin === new URL(BASE_URL).origin && url.pathname === "/", {
      timeout: 30_000,
    });
    const landing = await editor.evaluate(() => ({
      href: location.href,
      openerNull: window.opener === null,
      server: document.getElementById("url")?.value,
      pending: sessionStorage.getItem("limina.atlas-editor-handoff/pending"),
      isolated: crossOriginIsolated,
    }));
    if (
      !landing.openerNull ||
      landing.pending !== null ||
      !landing.isolated ||
      landing.server !== EXPECTED_HANDOFF_SERVER ||
      /token|focus|nonce|headHash/i.test(landing.href)
    ) {
      fail(`standalone relay landing contract failed: ${JSON.stringify(landing)}`);
    }
    await editor.locator("#auth-token").fill(TOKEN);
    await editor.locator("#connect").click();
    await editor.locator("#status-text").filter({ hasText: "connected" }).waitFor({ timeout: 15_000 });
    await editor.locator("#viewport-navigation-views-toggle").waitFor({ state: "visible" });
    try {
      await editor.waitForFunction(() => !document.getElementById("viewport-navigation-views-toggle")?.disabled, null, {
        timeout: 45_000,
      });
    } catch {
      const diagnostics = await editor.evaluate(() => ({
        viewport: document.getElementById("viewport-status")?.textContent,
        atlas: document.getElementById("viewport-atlas-status")?.textContent,
        connected: document.getElementById("status-text")?.textContent,
        viewsDisabled: document.getElementById("viewport-navigation-views-toggle")?.disabled,
        bodyClass: document.body.className,
      }));
      fail(`standalone handoff never became navigation-ready: ${JSON.stringify(diagnostics)}`);
    }
    await editor.locator("#viewport-navigation-views-toggle").click();
    await editor
      .locator("#viewport-navigation-recents")
      .filter({ hasText: /Grey Field|primary/i })
      .waitFor({ timeout: 45_000 });
    const after = await authority.callTool("authoring.sourceSnapshot", {});
    if (after.head.headHash !== before.head.headHash || after.head.revision !== before.head.revision) {
      fail(
        `standalone handoff mutated authority: before=${before.head.revision}/${before.head.headHash} after=${after.head.revision}/${after.head.headHash}`,
      );
    }

    const proxied = await context.newPage();
    await proxied.goto(`${BASE_URL}/atlas/`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await proxied.locator("#open-editor").waitFor({ state: "visible", timeout: 10_000 });
    await proxied.waitForFunction(() => document.getElementById("projname")?.textContent !== "Design Space", null, {
      timeout: 15_000,
    });
    const pagesBeforeRejectedLaunch = new Set(context.pages());
    await proxied.locator("#open-editor").click();
    await proxied
      .locator("#ds-toast")
      .filter({ hasText: /Atlas solo URL/ })
      .waitFor({ timeout: 10_000 });
    // The product closes the about:blank safety popup as soon as it detects the
    // proxied origin. On a fast local service Chromium may destroy it before
    // Playwright emits a `page` event, so observability of that transient window
    // is not part of the security contract. The contract is that no newly
    // surviving page reaches the editor origin.
    await proxied.waitForTimeout(100);
    const rejectedPopups = context.pages().filter((candidate) => !pagesBeforeRejectedLaunch.has(candidate));
    for (const rejectedPopup of rejectedPopups) {
      if (new URL(rejectedPopup.url()).origin === new URL(BASE_URL).origin) {
        fail(`proxied Atlas reached the editor handoff: ${rejectedPopup.url()}`);
      }
      await rejectedPopup.close();
    }
    await proxied.close();
    console.log(
      "atlas_standalone_handoff_browser.test OK: direct relay, one-shot exact focus, proxied rejection, authority unchanged",
    );
  } finally {
    authority.close();
    await context.close();
    await browser.close();
  }
})().catch((error) => fail(error?.stack ?? error?.message ?? String(error)));
