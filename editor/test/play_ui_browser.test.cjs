const assert = require("node:assert/strict");
const { chromeExecutable, loadChromium, requireChromeBinary } = require("./browser-env.cjs");

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) { console.log("SKIP: " + loaded.error); process.exit(2); }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  let browser;
  try { browser = await loaded.chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] }); }
  catch (error) { console.log("SKIP: could not launch Chromium (" + error.message + ")"); process.exit(2); }

  const screenshots = [];
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto((process.env.EDITOR_BASE_URL ?? "http://localhost:5173") + "/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#viewport-play-state");

      const controls = await page.evaluate(() => {
        let compass = document.querySelector(".viewport-compass");
        if (!compass) {
          compass = document.createElement("div");
          compass.className = "viewport-compass";
          compass.style.width = "44px";
          compass.style.height = "44px";
          document.getElementById("viewport-body").appendChild(compass);
        }
        const ids = ["viewport-play", "viewport-pause", "viewport-stop"];
        const boxes = ids.map((id) => {
          const node = document.getElementById(id);
          const rect = node.getBoundingClientRect();
          return {
            id, width: rect.width, height: rect.height, left: rect.left, right: rect.right,
            top: rect.top, bottom: rect.bottom, title: node.title,
            aria: node.getAttribute("aria-label"), disabled: node.disabled,
          };
        });
        const toolbar = document.querySelector(".play-toolbar").getBoundingClientRect();
        const viewportRect = document.getElementById("viewport").getBoundingClientRect();
        const canvasRect = document.getElementById("editor-viewport").getBoundingClientRect();
        const compassRect = compass.getBoundingClientRect();
        const pauseKey = new KeyboardEvent("keydown", { key: "F7", bubbles: true, cancelable: true });
        window.dispatchEvent(pauseKey);
        return { boxes, toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom },
          viewport: { left: viewportRect.left, right: viewportRect.right, top: viewportRect.top, bottom: viewportRect.bottom },
          canvas: { width: canvasRect.width, height: canvasRect.height },
          compass: { left: compassRect.left, right: compassRect.right, top: compassRect.top, bottom: compassRect.bottom },
          state: document.getElementById("viewport-play-state").textContent, pauseKeyHandled: pauseKey.defaultPrevented };
      });

      assert.equal(controls.state, "Edit");
      assert.equal(controls.pauseKeyHandled, true, "F7 keyboard control must be bound");
      assert.equal(controls.boxes[0].disabled, false);
      assert.equal(controls.boxes[1].disabled, true);
      assert.equal(controls.boxes[2].disabled, true);
      for (const box of controls.boxes) {
        assert.equal(box.width, 30, `${viewport.name} ${box.id} width must be stable`);
        assert.equal(box.height, 30, `${viewport.name} ${box.id} height must be stable`);
        assert.ok(box.title.length > 0 && box.aria.length > 0, `${box.id} needs title and aria-label`);
        assert.ok(box.left >= controls.viewport.left && box.right <= controls.viewport.right, `${box.id} must stay inside viewport`);
      }
      for (let index = 1; index < controls.boxes.length; index++) {
        assert.ok(controls.boxes[index - 1].right <= controls.boxes[index].left, `${viewport.name} Play controls overlap`);
      }
      assert.ok(controls.toolbar.left >= controls.viewport.left && controls.toolbar.right <= controls.viewport.right,
        `${viewport.name} toolbar must not overflow the viewport`);
      const toolbarOverlapsCompass = controls.toolbar.left < controls.compass.right && controls.toolbar.right > controls.compass.left &&
        controls.toolbar.top < controls.compass.bottom && controls.toolbar.bottom > controls.compass.top;
      assert.equal(toolbarOverlapsCompass, false, `${viewport.name} Play toolbar must not overlap the compass`);
      assert.ok(controls.canvas.width > 0 && controls.canvas.height > 0, `${viewport.name} canvas must retain drawable pixels`);

      const path = `/tmp/limina-play-ui-${viewport.name}.png`;
      await page.screenshot({ path, fullPage: true });
      screenshots.push(path);
      assert.deepEqual(errors, [], `${viewport.name} page errors: ${errors.join(" | ")}`);
      await page.close();
    }
    console.log(`play_ui_browser.test OK: ARIA, keyboard titles, stable 30px controls, and desktop/mobile no-overlap. Screenshots: ${screenshots.join(", ")}`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error("FAIL: " + error.stack); process.exit(1); });
