const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");
const { artifactPath } = require("./artifacts.cjs");

const CHROME = chromeExecutable();
const BASE_URL = process.env.EDITOR_BASE_URL || "http://localhost:5173";

function fail(message) { console.error("FAIL: " + message); process.exit(1); }

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  requireChromeBinary(CHROME);
  const browser = await loaded.chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  try {
    const response = await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => null);
    if (!response) { await browser.close(); skip(`editor not served on ${BASE_URL}`); }
    const result = await page.evaluate(async () => {
      const module = await import("/src/content-browser.js");
      module.contentBrowser?.destroy();
      const catalog = [];
      for (let index = 0; index < 5_000; index++) {
        catalog.push({
          id: index % 17 === 0 ? `archetype:item-${String(index).padStart(4, "0")}` : `models/item-${String(index).padStart(4, "0")}.glb`,
          title: index === 4_999 ? "Needle Keep" : `Asset ${String(index).padStart(4, "0")}`,
          category: index % 2 ? "prop" : "civic",
          boundsM: [1, 2, 3],
          tags: index === 4_999 ? ["needle"] : [],
        });
      }
      let calls = 0;
      let current = catalog;
      const view = module.createContentBrowser(document.getElementById("content-browser-root"), {
        placement: module.assetPlacement,
        loadCatalog: async () => {
          calls++;
          if (calls === 1) throw new Error("temporary catalog outage" + "x".repeat(1_000));
          return { entries: current };
        },
      });
      await module.openContentBrowser();
      for (let i = 0; i < 50 && !document.querySelector(".content-status-error"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const callsAfterOneOpen = calls;
      const errorText = document.querySelector(".content-status-error")?.textContent ?? "";
      const firstError = errorText.includes("temporary catalog outage") && errorText.length < 350;
      document.querySelector(".content-status-error button").click();
      for (let i = 0; i < 50 && view.stateSnapshot().entries.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const root = document.getElementById("content-browser-root");
      const boundedRows = root.querySelectorAll(".content-asset-row").length;
      const list = root.querySelector(".content-list");
      list.focus();
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      const firstArrowSelection = view.stateSnapshot().selectedId === view.stateSnapshot().entries[0].id;
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const keyboardArmed = module.assetPlacement.get().entry?.id === view.stateSnapshot().entries[0].id;
      const search = root.querySelector(".content-search");
      search.value = "needle";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      const filtered = view.stateSnapshot().filtered.length;
      const needleRow = root.querySelector(".content-asset-row");
      needleRow.click();
      const armedBefore = module.assetPlacement.get();
      module.assetPlacement.rotate(Math.PI / 2);
      current = catalog.map((entry) => entry.id === armedBefore.entry.id ? { ...entry, title: "Needle Keep Updated", boundsM: [8, 9, 10] } : entry);
      await view.refresh({ force: true });
      const armedAfter = module.assetPlacement.get();
      const snapshot = view.stateSnapshot();
      const selectedAfter = snapshot.selectedId;
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      const categoryFilter = root.querySelector('select[aria-label="Filter by category"]');
      categoryFilter.value = "civic";
      categoryFilter.dispatchEvent(new Event("change", { bubbles: true }));
      const categoryCount = view.stateSnapshot().filtered.length;
      const typeFilter = root.querySelector('select[aria-label="Filter by type"]');
      typeFilter.value = "glb";
      typeFilter.dispatchEvent(new Event("change", { bubbles: true }));
      const combinedCount = view.stateSnapshot().filtered.length;
      const rect = (element) => {
        if (!element || getComputedStyle(element).display === "none") return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      };
      return {
        firstError,
        callsAfterOneOpen,
        calls,
        total: snapshot.entries.length,
        boundedRows,
        firstArrowSelection,
        keyboardArmed,
        filtered,
        categoryCount,
        combinedCount,
        armedId: armedAfter.entry?.id,
        armedTitle: armedAfter.entry?.title,
        yaw: armedAfter.yaw,
        selectedAfter,
        viewportStatus: document.getElementById("viewport-status")?.textContent,
        rootWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        toolSurface: rect(document.querySelector(".viewport-tool-surface")),
        viewportToolbar: rect(document.querySelector(".viewport-tools")),
      };
    });
    await page.screenshot({ path: artifactPath("content_browser_desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const root = document.getElementById("content-browser-root");
      const sidebar = document.getElementById("sidebar-left").getBoundingClientRect();
      const viewport = document.getElementById("viewport").getBoundingClientRect();
      const rect = (element) => {
        if (!element || getComputedStyle(element).display === "none") return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      };
      return {
        rootWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        rows: root.querySelectorAll(".content-asset-row").length,
        sidebarBottom: sidebar.bottom,
        viewportTop: viewport.top,
        toolSurface: rect(document.querySelector(".viewport-tool-surface")),
        viewportToolbar: rect(document.querySelector(".viewport-tools")),
      };
    });
    await page.screenshot({ path: artifactPath("content_browser_mobile.png"), fullPage: true });
    await page.keyboard.press("Escape");
    const restored = await page.evaluate(() => {
      const rect = (element) => {
        if (!element || getComputedStyle(element).display === "none") return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      };
      return {
        status: document.getElementById("viewport-status")?.textContent,
        toolSurface: rect(document.querySelector(".viewport-tool-surface")),
        viewportToolbar: rect(document.querySelector(".viewport-tools")),
      };
    });
    await browser.close();
    if (!result.firstError || result.callsAfterOneOpen !== 1 || result.calls !== 3) fail(`one-open/one-load or error recovery failed: ${JSON.stringify(result)}`);
    if (result.total !== 5_000 || result.boundedRows > 40 || result.filtered !== 1) fail(`large catalog/filter virtualization failed: ${JSON.stringify(result)}`);
    if (!result.firstArrowSelection || !result.keyboardArmed) fail(`keyboard selection did not start at or arm the first asset: ${JSON.stringify(result)}`);
    if (!(result.categoryCount > result.combinedCount && result.combinedCount > 0)) fail(`category/type filtering failed: ${JSON.stringify(result)}`);
    if (result.armedId !== result.selectedAfter || result.armedTitle !== "Needle Keep Updated" || Math.abs(result.yaw - Math.PI / 2) > 1e-9) fail(`refresh lost selection/arming state: ${JSON.stringify(result)}`);
    if (!result.viewportStatus?.includes("place: Needle Keep")) fail(`viewport did not receive armed placement synchronously: ${JSON.stringify(result)}`);
    const overlaps = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    // The HUD is retired (2.0-C); the overlap invariant now binds the registry
    // ribbon (.viewport-tool-surface) against the bottom viewport controls.
    if (overlaps(result.toolSurface, result.viewportToolbar)) fail(`armed placement ribbon overlaps desktop viewport controls: ${JSON.stringify(result)}`);
    if (result.rootScrollWidth > result.rootWidth || mobile.rootScrollWidth > mobile.rootWidth || mobile.pageWidth > mobile.viewportWidth) fail(`Content Browser overflows layout: ${JSON.stringify({ result, mobile })}`);
    if (mobile.rows > 40) fail(`mobile virtualization is unbounded: ${JSON.stringify(mobile)}`);
    if (mobile.viewportTop < mobile.sidebarBottom - 1) fail(`mobile Content Browser overlaps the viewport: ${JSON.stringify(mobile)}`);
    if (overlaps(mobile.toolSurface, mobile.viewportToolbar)) fail(`armed placement ribbon overlaps mobile viewport controls: ${JSON.stringify(mobile)}`);
    if (!restored.status?.includes("tool: raise") || overlaps(restored.toolSurface, restored.viewportToolbar)) fail(`disarm did not restore a non-overlapping terrain tool state: ${JSON.stringify(restored)}`);
    if (errors.length > 0) fail("browser errors: " + errors.join(" | "));
    console.log(`content_browser_browser.test OK: ${result.total} assets, ${result.boundedRows} desktop rows, ${mobile.rows} mobile rows, error recovery and placement handoff verified`);
  } catch (error) {
    try { await browser.close(); } catch {}
    fail(error?.message ?? String(error));
  }
})();
