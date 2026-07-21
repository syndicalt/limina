// Boot loading overlay — "the island assembles itself". Covers the viewport canvas from
// connect-click until the first derived activation (or runtime-ready with no derived
// service), then fades out. Pure canvas 2D + CSS: no fonts, no images, no libraries.
// Constraints: zero randomness (shimmer seeds from a constant, the chunk grid reseeds from
// the manifest sha256, cell arrival order is an integer-hash sort). Every number on screen
// comes from a real boot event; indeterminate phases pulse and never invent a percentage.
// Canvas paints can't read CSS vars — PALETTE mirrors styles-studio.css tokens.
const PALETTE = Object.freeze({ cell: "#1c232d", accent: "#4aa3ff", edge: "#6db4ff" });
const SHIMMER_SEED = 0x9e3779b9; // pre-manifest seed (fixed, not chance)

const rgba = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
const accentAlpha = (a) => rgba(74, 163, 255, a);
const dangerAlpha = (a) => rgba(224, 122, 122, a);

// Copied from js/src/terrain/brush-kernel.mjs (the sanctioned copy site): integer-hash
// noise, no transcendentals, bit-identical on every host.
function hashNoise(col, row) {
  let h = (Math.imul(col, 374761393) + Math.imul(row, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Value noise (bilinear-smoothed); the seed shifts the lattice — a new seed, a new terrain.
function valueNoise(x, y, seedLo, seedHi) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hashNoise(x0 + seedLo, y0 + seedHi), b = hashNoise(x0 + 1 + seedLo, y0 + seedHi);
  const c = hashNoise(x0 + seedLo, y0 + 1 + seedHi), d = hashNoise(x0 + 1 + seedLo, y0 + 1 + seedHi);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Grid from the REAL manifest chunk layout (tx/tz) — the chunk set itself is the island's
// coastline. Arrival order: hash sort seeded from the manifest hash.
function buildGrid(manifest) {
  const chunks = Array.isArray(manifest?.chunks) ? manifest.chunks : undefined;
  if (!chunks || chunks.length === 0) return undefined;
  const pts = [];
  let minTx = Infinity, maxTx = -Infinity, minTz = Infinity, maxTz = -Infinity;
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk?.tx) || !Number.isSafeInteger(chunk?.tz)) return undefined;
    pts.push({ tx: chunk.tx, tz: chunk.tz });
    minTx = Math.min(minTx, chunk.tx); maxTx = Math.max(maxTx, chunk.tx);
    minTz = Math.min(minTz, chunk.tz); maxTz = Math.max(maxTz, chunk.tz);
  }
  let seed = SHIMMER_SEED;
  const hash = typeof manifest.manifestHash === "string" ? manifest.manifestHash : "";
  if (/^sha256:[0-9a-f]{16}/.test(hash)) seed = parseInt(hash.slice(7, 15), 16) | 0;
  const lo = seed & 0xffff, hi = (seed >>> 16) & 0xffff;
  const order = pts.map((_, i) => i)
    .sort((a, b) => hashNoise(pts[a].tx + lo, pts[a].tz + hi) - hashNoise(pts[b].tx + lo, pts[b].tz + hi));
  return { pts, order, cols: maxTx - minTx + 1, rows: maxTz - minTz + 1, minTx, minTz, seed };
}

export function createBootLoading({
  document: doc,
  mount,
  seed = SHIMMER_SEED,
  raf = (fn) => globalThis.requestAnimationFrame(fn),
  timers = globalThis,
  fadeMs = 420,
} = {}) {
  if (!doc || !mount) throw new TypeError("boot loading requires a document and a mount");
  const el = (tag, className, parent) => {
    const node = doc.createElement(tag);
    node.className = className;
    parent.appendChild(node);
    return node;
  };
  const root = el("div", "boot-loading", mount);
  const canvas = el("canvas", "boot-loading-canvas", root);
  const readout = el("div", "boot-loading-readout", root);
  const captionEl = el("div", "boot-loading-caption", readout);
  const detailEl = el("div", "boot-loading-detail", readout);
  const pctEl = el("div", "boot-loading-pct", root);
  // Node-gate fake DOMs have no 2D context; the state machine still runs.
  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

  const state = { phase: "connect", caption: "surveying the log", detail: "", percent: undefined,
    mode: "shimmer", grid: undefined, lit: 0, fetchFraction: undefined, seed };
  let disposed = false, fading = false, fadeTimer, rafHandle, drawnW = 0, drawnH = 0;
  let bandPrev = new Int16Array(128), bandCur = new Int16Array(128); // shimmer rows (cols ≤ 127)

  function present() {
    root.dataset.phase = state.phase;
    captionEl.textContent = state.caption;
    detailEl.textContent = state.detail;
    pctEl.textContent = state.percent === undefined ? "" : `${Math.round(state.percent)}%`;
  }

  // Later phases win — stale notes must not regress a fetch.
  const PHASE_RANK = { connect: 0, replay: 1, runtime: 2, fetch: 3, activate: 4 };
  function advance(phase, caption, detail, percent) {
    if (disposed || state.phase === "error") return;
    if ((PHASE_RANK[phase] ?? 0) < (PHASE_RANK[state.phase] ?? 0)) return;
    Object.assign(state, { phase, caption, detail, percent });
    present();
  }

  function applyLit() {
    if (!state.grid || state.fetchFraction === undefined) return;
    state.lit = Math.min(state.grid.pts.length, Math.round(state.fetchFraction * state.grid.pts.length));
  }

  function drawShimmer(w, h, t) {
    const cols = 112, rows = Math.max(28, Math.round((cols * h) / Math.max(1, w)));
    const cw = w / cols, ch = h / rows;
    const drift = t * 0.0004;
    const lo = state.seed & 0xffff, hi = (state.seed >>> 16) & 0xffff;
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= cols; x++) {
        bandCur[x] = (0.65 * valueNoise(x * 0.09 + drift, y * 0.09, lo, hi)
          + 0.35 * valueNoise(x * 0.23 - drift * 1.7, y * 0.23, hi, lo)) * 9 | 0;
      }
      for (let x = 0; x < cols; x++) {
        const band = bandCur[x];
        if (band === bandCur[x + 1] && (y === 0 || band === bandPrev[x])) continue;
        ctx.fillStyle = state.phase === "error" ? dangerAlpha(0.18) : accentAlpha(0.14 + 0.1 * Math.sin(t / 900 + band * 1.7));
        ctx.fillRect(x * cw, y * ch, cw, ch);
      }
      const swap = bandPrev; bandPrev = bandCur; bandCur = swap;
    }
  }

  function drawGrid(w, h, t) {
    const grid = state.grid;
    const pad = Math.max(18, Math.min(w, h) * 0.08);
    const size = Math.max(1, Math.min((w - 2 * pad) / grid.cols, (h - 2 * pad) / grid.rows));
    const gap = size > 4 ? 1 : 0;
    const ox = (w - size * grid.cols) / 2, oy = (h - size * grid.rows) / 2;
    const rect = (p) => ctx.fillRect(ox + (p.tx - grid.minTx) * size,
      oy + (p.tz - grid.minTz) * size, size - gap, size - gap);
    ctx.fillStyle = PALETTE.cell;
    for (const p of grid.pts) rect(p);
    ctx.fillStyle = PALETTE.accent;
    const n = Math.min(state.lit, grid.order.length);
    for (let i = 0; i < n; i++) rect(grid.pts[grid.order[i]]);
    // The frontier cell (last arrival) pulses — the piece set down right now.
    if (n > 0 && state.phase !== "error") {
      ctx.fillStyle = state.phase === "activate" ? PALETTE.edge : accentAlpha(0.45 + 0.4 * Math.sin(t / 220));
      rect(grid.pts[grid.order[n - 1]]);
    }
  }  function draw(t) {
    if (!ctx) return;
    // CSS pixels; cap DPR at 2 — stay featherweight on retina.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
    if (drawnW !== ((w * dpr) | 0) || drawnH !== ((h * dpr) | 0)) {
      drawnW = (w * dpr) | 0; drawnH = (h * dpr) | 0;
      canvas.width = drawnW; canvas.height = drawnH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (state.mode === "grid" && state.grid) drawGrid(w, h, t);
    else drawShimmer(w, h, t);
  }

  const frame = (t) => {
    // Stop flag only: an already-queued frame runs once more and does not re-register.
    if (disposed || rafHandle === undefined) return;
    draw(typeof t === "number" ? t : 0);
    rafHandle = raf(frame);
  };

  const api = {
    get cellCount() { return state.grid ? state.grid.pts.length : 0; },
    get litCount() { return state.lit; },

    // Worldlog count: real (known once reboot() partitions the log); the apply itself
    // has no per-command seam, so this phase pulses without a percent.
    setReplay(total) {
      advance("replay", "surveying the log",
        Number.isSafeInteger(total) && total > 0 ? `${total} authoring commands` : "", undefined);
    },

    // runLive onStatus steps; its loading details are stable strings, so caption mapping
    // is presentation, not progress scraping (counts come from the structured seams).
    runtimeStep(phase, detail) {
      const text = String(detail ?? "").slice(0, 240);
      let caption;
      if (phase === "ready") caption = "the stage is set";
      else if (phase !== "loading") return;
      else if (/^loading \d+ asset/.test(text)) caption = "gathering the props";
      else if (text.startsWith("spawning sim worker")) caption = "waking the sim";
      else if (text.startsWith("starting WebGPU") || text.startsWith("WebGPU unavailable")) caption = "warming the renderer";
      else if (text.startsWith("authoring scene meshes")) caption = "re-authoring the scene";
      else caption = "preparing the viewport";
      advance("runtime", caption, text, undefined);
    },

    // Derived fetch seam via the client onStatus; older workers never emit it → pulse.
    setFetch(fetched, total, manifest) {
      if (manifest !== undefined) api.setManifest(manifest);
      const honest = Number.isSafeInteger(fetched) && Number.isSafeInteger(total) && total > 0 && fetched <= total;
      if (honest) state.fetchFraction = fetched / total;
      applyLit();
      advance("fetch", "carrying the island home",
        honest ? `${fetched} / ${total}` : "", honest ? (fetched / total) * 100 : undefined);
    },

    // The manifest's real chunk grid replaces the shimmer; its hash reseeds.
    setManifest(manifest) {
      const grid = buildGrid(manifest);
      if (!grid || disposed) return;
      state.grid = grid;
      state.mode = "grid";
      state.seed = grid.seed;
      applyLit();
    },

    setActivating(revision) {
      if (state.grid) state.lit = state.grid.pts.length;
      advance("activate", "raising the land", Number.isSafeInteger(revision) ? `r${revision}` : "", undefined);
    },

    // Boot failure: the overlay STAYS with the error text — never spins forever.
    fail(message) {
      if (disposed) return;
      state.phase = "error";
      state.caption = "boot failed";
      state.detail = String(message ?? "unknown error").slice(0, 240);
      state.percent = undefined;
      present();
      rafHandle = undefined; // freeze: a stopped loop can't be mistaken for progress
      draw(0);
    },

    done() {
      if (disposed || fading) return;
      fading = true;
      root.classList.add("boot-loading-fade");
      fadeTimer = timers.setTimeout(() => api.dispose(), fadeMs);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      rafHandle = undefined;
      if (fadeTimer !== undefined) timers.clearTimeout(fadeTimer);
      root.remove?.();
    },
  };

  present();
  rafHandle = raf(frame);
  return api;
}
