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
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const response = await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (!response) { await browser.close(); skip(`editor not served on ${BASE_URL}`); }
    const result = await page.evaluate(async () => {
      const [{ createOutlinerView }, { editorSelection }] = await Promise.all([
        import("/src/outliner.js"),
        import("/src/selection-store.js"),
      ]);
      const root = document.getElementById("outliner-root");
      const view = createOutlinerView(root, editorSelection);
      const records = [{ entity: "root", parent: null, tags: ["world"] }];
      for (let index = 0; index < 250; index++) {
        records.push({ entity: `child-${String(index).padStart(3, "0")}`, parent: "root", tags: index === 249 ? ["target"] : [] });
      }
      view.setEntities(records);
      const initialRenderedRows = root.querySelectorAll(".outliner-row").length;
      const initialScrollHeight = root.querySelector(".outliner-spacer")?.style.height;
      root.querySelector('[data-entity-id="root"] .outliner-toggle')?.click();
      editorSelection.select("child-249", "viewport");
      const revealScrollTop = root.querySelector(".outliner-tree")?.scrollTop;
      const revealedSelection = root.querySelector('[data-entity-id="child-249"]')?.classList.contains("selected") === true;
      const search = root.querySelector("input[type=search]");
      search.value = "target";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        renderedRows: root.querySelectorAll(".outliner-row").length,
        initialRenderedRows,
        initialScrollHeight,
        revealedSelection,
        revealScrollTop,
        selected: root.querySelector('[data-entity-id="child-249"]')?.classList.contains("selected") === true,
        targetVisible: root.querySelector('[data-entity-id="child-249"]') !== null,
        rootVisible: root.querySelector('[data-entity-id="root"]') !== null,
        treeScrollHeight: root.querySelector(".outliner-spacer")?.style.height,
      };
    });
    await page.screenshot({ path: artifactPath("outliner_browser.png"), fullPage: true });
    await page.locator("#inspector .win-close").click();
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const root = document.getElementById("outliner-root");
      return {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    await page.screenshot({ path: artifactPath("outliner_browser_mobile.png"), fullPage: true });
    await browser.close();
    if (!result.revealedSelection || !(result.revealScrollTop > 0) || !result.selected || !result.targetVisible || !result.rootVisible) {
      fail(`selection reveal/filter render failed: ${JSON.stringify(result)}`);
    }
    if (result.initialRenderedRows > 40 || result.initialScrollHeight !== "6024px") {
      fail(`virtualized Outliner did not bound the 251-row tree: ${JSON.stringify(result)}`);
    }
    if (mobile.scrollWidth > mobile.clientWidth || mobile.pageWidth > mobile.viewportWidth) {
      fail(`editor overflows mobile width: ${JSON.stringify(mobile)}`);
    }
    if (errors.length > 0) fail("browser errors: " + errors.join(" | "));
    console.log(`outliner_browser.test OK: 251-node hierarchy virtualized to ${result.initialRenderedRows} rows; selection/filter preserved ancestors`);
  } catch (error) {
    try { await browser.close(); } catch {}
    fail(error?.message ?? String(error));
  }
})();
