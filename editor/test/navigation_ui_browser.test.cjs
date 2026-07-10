const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");
const { artifactPath } = require("./artifacts.cjs");

const CHROME = chromeExecutable();
const BASE_URL = process.env.EDITOR_BASE_URL || "http://localhost:5173";

function fail(message) { console.error("FAIL: " + message); process.exit(1); }

function inside(inner, outer, tolerance = 1) {
  return inner.left >= outer.left - tolerance && inner.top >= outer.top - tolerance
    && inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
}

function overlaps(left, right) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  requireChromeBinary(CHROME);
  const browser = await loaded.chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const response = await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => null);
    if (!response) { await browser.close(); skip(`editor not served on ${BASE_URL}`); }

    const measure = () => page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element || getComputedStyle(element).display === "none") return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      return {
        viewport: rect("#viewport"),
        graphics: rect(".viewport-graphics"),
        navigation: rect(".navigation-toolbar"),
        goto: rect("#viewport-navigation-goto"),
        views: rect("#viewport-navigation-views"),
        tools: rect(".viewport-tools"),
        documentWidth: document.documentElement.scrollWidth,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        navigationClientWidth: document.querySelector(".navigation-toolbar")?.clientWidth,
        navigationScrollWidth: document.querySelector(".navigation-toolbar")?.scrollWidth,
      };
    });

    const initial = await measure();
    if (!initial.viewport || !initial.graphics || !initial.navigation || initial.goto || initial.views) {
      fail(`navigation overlay did not initialize correctly: ${JSON.stringify(initial)}`);
    }
    if (initial.navigation.top < initial.graphics.bottom - 1 || !inside(initial.navigation, initial.viewport)) {
      fail(`navigation is not below graphics inside the viewport: ${JSON.stringify(initial)}`);
    }

    await page.evaluate(() => { document.getElementById("viewport-navigation-goto").hidden = false; });
    const desktopGoto = await measure();
    if (!desktopGoto.goto || !inside(desktopGoto.goto, desktopGoto.viewport)) {
      fail(`desktop coordinate panel escaped the viewport: ${JSON.stringify(desktopGoto)}`);
    }
    await page.screenshot({ path: artifactPath("navigation_ui_desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileGoto = await measure();
    if (!mobileGoto.goto || mobileGoto.documentWidth > mobileGoto.windowWidth || mobileGoto.goto.left < 0 || mobileGoto.goto.right > mobileGoto.windowWidth
        || mobileGoto.navigationScrollWidth > mobileGoto.navigationClientWidth) {
      fail(`mobile coordinate panel overflows: ${JSON.stringify(mobileGoto)}`);
    }
    await page.evaluate(() => {
      document.getElementById("viewport-navigation-goto").hidden = true;
      document.getElementById("viewport-navigation-views").hidden = false;
    });
    const mobileViews = await measure();
    if (!mobileViews.views || mobileViews.documentWidth > mobileViews.windowWidth
        || mobileViews.views.left < 0 || mobileViews.views.right > mobileViews.windowWidth
        || !inside(mobileViews.views, mobileViews.viewport)
        || (mobileViews.tools && overlaps(mobileViews.views, mobileViews.tools))) {
      fail(`mobile views panel overflows: ${JSON.stringify(mobileViews)}`);
    }
    await page.screenshot({ path: artifactPath("navigation_ui_mobile.png"), fullPage: true });
    if (pageErrors.length > 0) fail("browser errors: " + pageErrors.join(" | "));
    console.log("navigation_ui_browser.test OK: navigation below graphics; hidden panels bounded at desktop and 390x844 mobile");
  } catch (error) {
    try { await browser.close(); } catch {}
    fail(error?.message ?? String(error));
  }
  await browser.close();
})();
