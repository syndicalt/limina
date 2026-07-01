// Shared Playwright/chromium resolvers for the host-side tools (tools/shoot.mjs, tools/director/*).
// ESM, no deps: locate playwright-core (installed or npx-cached) and a chromium binary (env or the
// ms-playwright cache). Returns null when nothing is found so callers can skip/exit as they like.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolvePwc() {
  if (process.env.PWC_PATH) return process.env.PWC_PATH;
  try { return require.resolve("playwright-core"); } catch { /* fall through */ }
  const npx = join(process.env.HOME || "", ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) {
    const p = join(npx, d, "node_modules", "playwright-core");
    if (existsSync(p)) return p;
  }
  return null;
}

export function resolveChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = join(process.env.HOME || "", ".cache", "ms-playwright");
  if (existsSync(base)) for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
    const p = join(base, d, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  return null;
}
