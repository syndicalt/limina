export const GRAPHICS_QUALITY_STORAGE_KEY = "limina.editor.graphicsQuality";
export const GRAPHICS_QUALITY_TIERS = Object.freeze(["performance", "balanced", "cinematic"]);

const QUALITY_TIER_SET = new Set(GRAPHICS_QUALITY_TIERS);
const TELEMETRY_INTERVAL_MS = 500;
const UINT32_MAX = 0xffff_ffff;
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

function isQualityTier(value) {
  return typeof value === "string" && QUALITY_TIER_SET.has(value);
}

function warn(logger, message, error) {
  try { logger?.warn?.(message, error); }
  catch { /* diagnostics must not break the settings control */ }
}

function boundedNumber(value, maximum, decimals = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  const scale = 10 ** decimals;
  return Math.round(Math.min(value, maximum) * scale) / scale;
}

function compactCount(value) {
  const count = boundedNumber(value, MAX_SAFE_COUNT);
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(count >= 100_000_000 ? 0 : 1)}M`;
  return `${(count / 1_000_000_000).toFixed(count >= 100_000_000_000 ? 0 : 1)}B`;
}

function titleCaseTier(value) {
  const tier = isQualityTier(value) ? value : "balanced";
  return tier[0].toUpperCase() + tier.slice(1);
}

/** Read a persisted quality tier without allowing malformed state into the runtime. */
export function readGraphicsQuality(storage) {
  try {
    const stored = storage?.getItem?.(GRAPHICS_QUALITY_STORAGE_KEY);
    return isQualityTier(stored) ? stored : "balanced";
  } catch {
    return "balanced";
  }
}

/** Convert an untrusted runtime telemetry snapshot into bounded display strings. */
export function formatGraphicsTelemetry(snapshot) {
  const samples = boundedNumber(snapshot?.samples, UINT32_MAX);
  if (samples < 2) {
    return Object.freeze({
      ready: false,
      text: "FPS -- | p95 -- ms | draws -- | triangles --",
      title: "Waiting for render telemetry",
    });
  }

  const tier = titleCaseTier(snapshot?.tier);
  const fps = boundedNumber(snapshot?.fps?.mean, 1_000, 1);
  const frameP95 = boundedNumber(snapshot?.frameMs?.p95, 60_000, 1);
  const drawCalls = boundedNumber(snapshot?.render?.drawCalls, UINT32_MAX);
  const triangles = boundedNumber(snapshot?.render?.triangles, MAX_SAFE_COUNT);
  const width = boundedNumber(snapshot?.backingWidth, UINT32_MAX);
  const height = boundedNumber(snapshot?.backingHeight, UINT32_MAX);
  const dpr = boundedNumber(snapshot?.pixelRatio, 16, 2);
  const textures = boundedNumber(snapshot?.memory?.textures, UINT32_MAX);
  const geometries = boundedNumber(snapshot?.memory?.geometries, UINT32_MAX);
  const programs = boundedNumber(snapshot?.memory?.programs, UINT32_MAX);
  const renderTargets = boundedNumber(snapshot?.memory?.renderTargets, UINT32_MAX);
  const memoryMiB = boundedNumber(snapshot?.memory?.total, MAX_SAFE_COUNT) / (1024 * 1024);

  return Object.freeze({
    ready: true,
    text: `FPS ${fps.toFixed(1)} | p95 ${frameP95.toFixed(1)} ms | draws ${Math.round(drawCalls)} | triangles ${compactCount(triangles)}`,
    title: `${tier} | ${Math.round(width)}x${Math.round(height)} | DPR ${dpr.toFixed(2)} | textures ${Math.round(textures)} | geometries ${Math.round(geometries)} | programs ${Math.round(programs)} | RT ${Math.round(renderTargets)} | memory ${memoryMiB.toFixed(1)} MiB`,
  });
}

function qualityTierForButton(button) {
  return button?.dataset?.qualityTier ?? button?.getAttribute?.("data-quality-tier");
}

/**
 * Own the editor graphics quality selector and its bounded telemetry readout.
 * The caller supplies runtime accessors because Edit and isolated Play runtimes change over time.
 */
export function createGraphicsSettings({
  group,
  buttons,
  telemetry,
  getRuntimeTargets = () => [],
  getTelemetryRuntime = () => undefined,
  storage,
  document = globalThis.document,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  logger = globalThis.console,
} = {}) {
  if (!group?.setAttribute) throw new TypeError("graphics settings group is required");
  if (typeof getRuntimeTargets !== "function") throw new TypeError("getRuntimeTargets must be a function");
  if (typeof getTelemetryRuntime !== "function") throw new TypeError("getTelemetryRuntime must be a function");
  if (typeof setInterval !== "function" || typeof clearInterval !== "function") {
    throw new TypeError("graphics settings timers are required");
  }

  let resolvedStorage = storage;
  if (resolvedStorage === undefined) {
    try { resolvedStorage = globalThis.localStorage; }
    catch { resolvedStorage = undefined; }
  }

  const suppliedButtons = Array.from(buttons ?? []);
  const byTier = new Map();
  for (const button of suppliedButtons) {
    const tier = qualityTierForButton(button);
    if (!isQualityTier(tier)) throw new TypeError(`invalid graphics quality button tier: ${String(tier)}`);
    if (byTier.has(tier)) throw new TypeError(`duplicate graphics quality button tier: ${tier}`);
    if (!button?.setAttribute || typeof button.addEventListener !== "function" || typeof button.removeEventListener !== "function") {
      throw new TypeError(`graphics quality button for ${tier} is invalid`);
    }
    byTier.set(tier, button);
  }
  for (const tier of GRAPHICS_QUALITY_TIERS) {
    if (!byTier.has(tier)) throw new TypeError(`missing graphics quality button tier: ${tier}`);
  }

  const orderedButtons = GRAPHICS_QUALITY_TIERS.map((tier) => byTier.get(tier));
  const listeners = [];
  let tier = readGraphicsQuality(resolvedStorage);
  let disposed = false;

  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Graphics quality");

  function syncButtons({ focus = false } = {}) {
    for (let index = 0; index < orderedButtons.length; index++) {
      const button = orderedButtons[index];
      const buttonTier = GRAPHICS_QUALITY_TIERS[index];
      const selected = buttonTier === tier;
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", selected ? "true" : "false");
      button.setAttribute("tabindex", selected ? "0" : "-1");
      if (selected && focus) button.focus?.();
    }
  }

  function applyToRuntimeTargets() {
    let targets;
    try { targets = getRuntimeTargets(); }
    catch (error) {
      warn(logger, "graphics quality runtime discovery failed", error);
      return;
    }

    const unique = new Set();
    try {
      for (const runtime of targets ?? []) {
        if (runtime === null || runtime === undefined || unique.has(runtime)) continue;
        unique.add(runtime);
        if (typeof runtime.setRenderQuality !== "function") continue;
        try {
          const pending = runtime.setRenderQuality(tier);
          if (pending && typeof pending.then === "function") {
            pending.catch((error) => warn(logger, "graphics quality runtime update failed", error));
          }
        } catch (error) {
          warn(logger, "graphics quality runtime update failed", error);
        }
      }
    } catch (error) {
      warn(logger, "graphics quality runtime targets were not iterable", error);
    }
  }

  function persistTier() {
    try { resolvedStorage?.setItem?.(GRAPHICS_QUALITY_STORAGE_KEY, tier); }
    catch (error) { warn(logger, "graphics quality persistence failed", error); }
  }

  function setTier(nextTier, { focus = false, persist = true } = {}) {
    if (disposed) return false;
    if (!isQualityTier(nextTier)) throw new TypeError(`invalid graphics quality tier: ${String(nextTier)}`);
    const changed = tier !== nextTier;
    tier = nextTier;
    syncButtons({ focus });
    if (persist) persistTier();
    applyToRuntimeTargets();
    return changed;
  }

  function moveSelection(fromTier, key) {
    const current = GRAPHICS_QUALITY_TIERS.indexOf(fromTier);
    let next = current;
    if (key === "ArrowLeft" || key === "ArrowUp") next = (current - 1 + GRAPHICS_QUALITY_TIERS.length) % GRAPHICS_QUALITY_TIERS.length;
    else if (key === "ArrowRight" || key === "ArrowDown") next = (current + 1) % GRAPHICS_QUALITY_TIERS.length;
    else if (key === "Home") next = 0;
    else if (key === "End") next = GRAPHICS_QUALITY_TIERS.length - 1;
    else return false;
    setTier(GRAPHICS_QUALITY_TIERS[next], { focus: true });
    return true;
  }

  for (let index = 0; index < orderedButtons.length; index++) {
    const button = orderedButtons[index];
    const buttonTier = GRAPHICS_QUALITY_TIERS[index];
    const onClick = () => setTier(buttonTier);
    const onKeyDown = (event) => {
      if (!moveSelection(buttonTier, event.key)) return;
      event.preventDefault?.();
    };
    button.addEventListener("click", onClick);
    button.addEventListener("keydown", onKeyDown);
    listeners.push([button, "click", onClick], [button, "keydown", onKeyDown]);
  }

  const renderTelemetry = (formatted) => {
    if (!telemetry) return;
    telemetry.textContent = formatted.text;
    telemetry.title = formatted.title;
  };

  function sampleTelemetry() {
    if (disposed || document?.visibilityState === "hidden") return false;
    let runtime;
    try { runtime = getTelemetryRuntime(); }
    catch (error) {
      warn(logger, "graphics telemetry runtime discovery failed", error);
      renderTelemetry(formatGraphicsTelemetry(undefined));
      return false;
    }
    if (typeof runtime?.renderTelemetry !== "function") {
      renderTelemetry(formatGraphicsTelemetry(undefined));
      return false;
    }
    try {
      const formatted = formatGraphicsTelemetry(runtime.renderTelemetry());
      renderTelemetry(formatted);
      return formatted.ready;
    } catch (error) {
      warn(logger, "graphics telemetry sampling failed", error);
      renderTelemetry(formatGraphicsTelemetry(undefined));
      return false;
    }
  }

  syncButtons();
  renderTelemetry(formatGraphicsTelemetry(undefined));
  applyToRuntimeTargets();
  const telemetryTimer = setInterval(sampleTelemetry, TELEMETRY_INTERVAL_MS);

  return Object.freeze({
    get tier() { return tier; },
    setTier,
    sampleTelemetry,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(telemetryTimer);
      for (const [target, eventName, listener] of listeners) target.removeEventListener(eventName, listener);
      listeners.length = 0;
    },
  });
}
