const fs = require("fs");
const path = require("path");

function skip(reason) {
  console.log("SKIP: " + reason);
  process.exit(2);
}

function chromeExecutable() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  // Resolve the NEWEST installed playwright chromium — a pinned chromium-NNNN path
  // rots every time playwright updates its browser revision.
  const base = path.join(process.env.HOME || "", ".cache", "ms-playwright");
  if (fs.existsSync(base)) {
    const revisions = fs.readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const rev of revisions) {
      // x64 unpacks to chrome-linux64/, arm64 to chrome-linux/ — try both.
      for (const layout of ["chrome-linux64", "chrome-linux"]) {
        const candidate = path.join(base, rev, layout, "chrome");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return path.join(base, "chromium-none", "chrome-linux64", "chrome");
}

function loadChromium() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_CORE_PATH) candidates.push(process.env.PLAYWRIGHT_CORE_PATH);
  if (process.env.PWC_PATH) candidates.push(process.env.PWC_PATH);
  try {
    candidates.push(require.resolve("playwright-core", {
      paths: [
        process.cwd(),
        path.join(process.cwd(), "js"),
        path.join(process.cwd(), "tools"),
        __dirname,
      ],
    }));
  } catch {
    // No locally installed playwright-core; caller will skip.
  }

  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (mod && mod.chromium) return { chromium: mod.chromium };
    } catch {
      // Try the next configured/module-resolution path.
    }
  }
  return { error: "playwright-core not loadable; set PLAYWRIGHT_CORE_PATH or install it in js/tools" };
}

function requireChromeBinary(chromePath) {
  if (!fs.existsSync(chromePath)) skip("chromium not found at " + chromePath);
}

module.exports = { chromeExecutable, loadChromium, requireChromeBinary, skip };
