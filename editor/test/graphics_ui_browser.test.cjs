const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

const overlaps = (left, right) => left.left < right.right && left.right > right.left
  && left.top < right.bottom && left.bottom > right.top;

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  const browser = await loaded.chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  const screenshots = [];
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#viewport-graphics-quality");

      assert.equal(await page.getAttribute('[data-quality-tier="balanced"]', "aria-checked"), "true");
      await page.focus('[data-quality-tier="balanced"]');
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.getAttribute('[data-quality-tier="cinematic"]', "aria-checked"), "true",
        `${viewport.name} keyboard navigation did not select Cinematic`);
      await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(await page.getAttribute('[data-quality-tier="cinematic"]', "aria-checked"), "true",
        `${viewport.name} quality selection did not survive reload`);

      const layout = await page.evaluate(() => {
        let compass = document.querySelector(".viewport-compass");
        if (!compass) {
          compass = document.createElement("div");
          compass.className = "viewport-compass";
          compass.style.cssText = "width:44px;height:44px";
          document.getElementById("viewport-body").appendChild(compass);
        }
        const rect = (selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const buttons = [...document.querySelectorAll("[data-quality-tier]")].map((button) => ({
          tier: button.dataset.qualityTier,
          checked: button.getAttribute("aria-checked"),
          tabIndex: button.tabIndex,
          box: (() => { const b = button.getBoundingClientRect(); return { width: b.width, height: b.height }; })(),
        }));
        return {
          graphics: rect(".viewport-graphics"),
          segments: rect(".graphics-segments"),
          telemetry: rect(".graphics-telemetry"),
          play: rect(".play-toolbar"),
          compass: rect(".viewport-compass"),
          tools: rect(".viewport-tools"),
          viewport: rect("#viewport"),
          pageWidth: document.documentElement.scrollWidth,
          windowWidth: window.innerWidth,
          buttons,
          role: document.getElementById("viewport-graphics-quality").getAttribute("role"),
          label: document.getElementById("viewport-graphics-quality").getAttribute("aria-label"),
        };
      });

      assert.equal(layout.role, "radiogroup");
      assert.ok(layout.label.length > 0, "quality radiogroup has no accessible label");
      assert.equal(layout.buttons.filter((button) => button.checked === "true").length, 1, "quality has multiple selections");
      assert.equal(layout.buttons.filter((button) => button.tabIndex === 0).length, 1, "quality roving tabindex is invalid");
      for (const button of layout.buttons) {
        assert.ok(button.box.width >= 70 && button.box.height === 28, `${viewport.name} ${button.tier} has unstable dimensions`);
      }
      assert.ok(layout.graphics.left >= layout.viewport.left && layout.graphics.right <= layout.viewport.right,
        `${viewport.name} graphics overlay left the viewport`);
      assert.equal(overlaps(layout.graphics, layout.play), false, `${viewport.name} graphics overlay overlaps Play controls`);
      assert.equal(overlaps(layout.graphics, layout.compass), false, `${viewport.name} graphics overlay overlaps compass`);
      assert.equal(overlaps(layout.graphics, layout.tools), false, `${viewport.name} graphics overlay overlaps bottom tools`);
      assert.ok(layout.telemetry.width >= 250 && layout.telemetry.height >= 24, `${viewport.name} telemetry has unstable dimensions`);
      assert.ok(layout.pageWidth <= layout.windowWidth, `${viewport.name} graphics UI causes horizontal overflow`);
      assert.deepEqual(pageErrors, [], `${viewport.name} page errors: ${pageErrors.join(" | ")}`);

      const screenshot = `/tmp/limina-graphics-ui-${viewport.name}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      assert.ok(fs.statSync(screenshot).size > 10_000, `${viewport.name} graphics screenshot is empty`);
      screenshots.push(screenshot);
      await context.close();
    }
    console.log(`graphics_ui_browser.test OK: ARIA, keyboard, persistence, stable desktop/mobile layout; ${screenshots.join(", ")}`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
