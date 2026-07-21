import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAPHICS_QUALITY_STORAGE_KEY,
  createGraphicsSettings,
  formatGraphicsTelemetry,
  readGraphicsQuality,
} from "../src/graphics-settings.js";

class FakeElement {
  constructor(tier) {
    this.dataset = tier ? { qualityTier: tier } : {};
    this.attributes = {};
    this.listeners = new Map();
    this.focused = false;
    this.textContent = "";
    this.title = "";
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name === "data-quality-tier" ? this.dataset.qualityTier : this.attributes[name]; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name, fields = {}) {
    const event = { key: fields.key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  focus() { this.focused = true; }
}

function fixture(overrides = {}) {
  const group = new FakeElement();
  const buttons = [new FakeElement("performance"), new FakeElement("balanced"), new FakeElement("cinematic")];
  const telemetry = new FakeElement();
  const intervals = [];
  const cleared = [];
  const storageValues = new Map();
  const storage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
  };
  const options = {
    group,
    buttons,
    telemetry,
    storage,
    document: { visibilityState: "visible" },
    getRuntimeTargets: () => [],
    getTelemetryRuntime: () => undefined,
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
    clearInterval(id) { cleared.push(id); },
    logger: { warn() {} },
    ...overrides,
  };
  return { group, buttons, telemetry, intervals, cleared, storage, storageValues, options };
}

function snapshot(overrides = {}) {
  return {
    samples: 20,
    tier: "cinematic",
    backingWidth: 1920,
    backingHeight: 1080,
    pixelRatio: 1.5,
    fps: { mean: 59.94 },
    frameMs: { p95: 18.25 },
    render: { drawCalls: 42, triangles: 1_250_000 },
    memory: { textures: 10, geometries: 11, programs: 12, renderTargets: 3, total: 32 * 1024 * 1024 },
    ...overrides,
  };
}

test("persisted quality accepts only exact tiers and tolerates storage failures", () => {
  const valid = { getItem: () => "cinematic" };
  assert.equal(readGraphicsQuality(valid), "cinematic");
  for (const malformed of [undefined, null, "", "Cinematic", "ultra", 1, {}, []]) {
    assert.equal(readGraphicsQuality({ getItem: () => malformed }), "balanced");
  }
  assert.equal(readGraphicsQuality({ getItem() { throw new Error("blocked"); } }), "balanced");
});

test("controller establishes radio semantics, persists before applying, and deduplicates runtimes", () => {
  const events = [];
  const shared = { setRenderQuality(tier) { events.push(`shared:${tier}`); } };
  const second = { setRenderQuality(tier) { events.push(`second:${tier}`); } };
  const f = fixture({
    storage: {
      getItem: () => "performance",
      setItem(key, value) { events.push(`persist:${key}:${value}`); },
    },
    getRuntimeTargets: () => [shared, shared, null, second],
  });
  const controller = createGraphicsSettings(f.options);

  assert.equal(controller.tier, "performance");
  assert.equal(f.group.attributes.role, "radiogroup");
  assert.equal(f.group.attributes["aria-label"], "Graphics quality");
  assert.deepEqual(f.buttons.map((button) => button.attributes.role), ["radio", "radio", "radio"]);
  assert.deepEqual(f.buttons.map((button) => button.attributes["aria-checked"]), ["true", "false", "false"]);
  assert.deepEqual(f.buttons.map((button) => button.attributes.tabindex), ["0", "-1", "-1"]);
  assert.deepEqual(events, ["shared:performance", "second:performance"], "initial tier must reach each unique runtime once");

  f.buttons[2].dispatch("click");
  assert.deepEqual(events.slice(-3), [
    `persist:${GRAPHICS_QUALITY_STORAGE_KEY}:cinematic`,
    "shared:cinematic",
    "second:cinematic",
  ], "persistence must precede runtime application");
  assert.deepEqual(f.buttons.map((button) => button.attributes["aria-checked"]), ["false", "false", "true"]);
  controller.dispose();
});

test("storage and individual runtime failures do not block healthy runtimes", () => {
  const applied = [];
  const warnings = [];
  const f = fixture({
    storage: { getItem: () => "balanced", setItem() { throw new Error("quota"); } },
    getRuntimeTargets: () => [
      { setRenderQuality() { throw new Error("lost context"); } },
      { setRenderQuality(tier) { applied.push(tier); } },
    ],
    logger: { warn(message) { warnings.push(message); } },
  });
  const controller = createGraphicsSettings(f.options);
  f.buttons[0].dispatch("click");
  assert.deepEqual(applied, ["balanced", "performance"]);
  assert(warnings.includes("graphics quality persistence failed"));
  assert.equal(warnings.filter((message) => message === "graphics quality runtime update failed").length, 2);
  controller.dispose();
});

test("keyboard navigation wraps, supports vertical arrows and boundaries, and moves focus", () => {
  const f = fixture({ storage: { getItem: () => "balanced", setItem() {} } });
  const controller = createGraphicsSettings(f.options);

  let event = f.buttons[1].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(controller.tier, "cinematic");
  assert.equal(f.buttons[2].focused, true);

  event = f.buttons[2].dispatch("keydown", { key: "ArrowDown" });
  assert.equal(controller.tier, "performance");
  assert.equal(event.defaultPrevented, true);
  f.buttons[0].dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(controller.tier, "cinematic");
  f.buttons[2].dispatch("keydown", { key: "ArrowUp" });
  assert.equal(controller.tier, "balanced");
  f.buttons[1].dispatch("keydown", { key: "Home" });
  assert.equal(controller.tier, "performance");
  f.buttons[0].dispatch("keydown", { key: "End" });
  assert.equal(controller.tier, "cinematic");
  event = f.buttons[2].dispatch("keydown", { key: "Enter" });
  assert.equal(event.defaultPrevented, false);
  assert.equal(controller.tier, "cinematic");
  controller.dispose();
});

test("telemetry sampler runs every 500 ms only while visible and keeps the warm-up placeholder", () => {
  let calls = 0;
  const document = { visibilityState: "visible" };
  const runtime = { renderTelemetry() { calls++; return snapshot({ samples: calls }); } };
  const f = fixture({ document, getTelemetryRuntime: () => runtime });
  const controller = createGraphicsSettings(f.options);

  assert.equal(f.intervals.length, 1);
  assert.equal(f.intervals[0].delay, 500);
  assert.match(f.telemetry.textContent, /FPS --/);
  f.intervals[0].callback();
  assert.equal(calls, 1);
  assert.match(f.telemetry.textContent, /FPS --/, "one sample must remain a placeholder");

  document.visibilityState = "hidden";
  f.intervals[0].callback();
  assert.equal(calls, 1, "hidden tabs must not touch runtime telemetry");
  document.visibilityState = "visible";
  f.intervals[0].callback();
  assert.equal(calls, 2);
  assert.match(f.telemetry.textContent, /FPS 59\.9 \| p95 18\.3 ms \| draws 42 \| triangles 1\.3M/);
  assert.match(f.telemetry.title, /Cinematic \| 1920x1080 \| DPR 1\.50/);
  assert.match(f.telemetry.title, /textures 10 \| geometries 11 \| programs 12 \| RT 3 \| memory 32\.0 MiB/);
  controller.dispose();
});

test("telemetry formatting contains hostile values and never emits NaN or Infinity", () => {
  const formatted = formatGraphicsTelemetry(snapshot({
    samples: Number.POSITIVE_INFINITY,
    tier: "ultra",
    backingWidth: -100,
    backingHeight: Number.POSITIVE_INFINITY,
    pixelRatio: 999,
    fps: { mean: Number.NaN },
    frameMs: { p95: -1 },
    render: { drawCalls: Number.POSITIVE_INFINITY, triangles: Number.MAX_VALUE },
    memory: { textures: -1, geometries: Number.NaN, programs: 1e100, renderTargets: Infinity, total: 1e100 },
  }));
  assert.equal(formatted.ready, false, "invalid sample counts cannot expose untrusted telemetry");

  const bounded = formatGraphicsTelemetry(snapshot({
    samples: 2,
    tier: "ultra",
    backingWidth: 1e100,
    backingHeight: 1e100,
    pixelRatio: 999,
    fps: { mean: 1e100 },
    frameMs: { p95: 1e100 },
    render: { drawCalls: 1e100, triangles: 1e100 },
    memory: { textures: 1e100, geometries: 1e100, programs: 1e100, renderTargets: 1e100, total: 1e100 },
  }));
  assert.equal(bounded.ready, true);
  assert.doesNotMatch(`${bounded.text} ${bounded.title}`, /NaN|Infinity|undefined/);
  assert.match(bounded.title, /^Balanced \| 4294967295x4294967295 \| DPR 16\.00/);
});

test("dispose removes listeners, clears the interval once, and prevents later sampling", () => {
  let samples = 0;
  const f = fixture({ getTelemetryRuntime: () => ({ renderTelemetry() { samples++; return snapshot(); } }) });
  const controller = createGraphicsSettings(f.options);
  controller.dispose();
  controller.dispose();
  assert.deepEqual(f.cleared, [1]);
  assert.equal(f.buttons.every((button) => [...button.listeners.values()].every((listeners) => listeners.size === 0)), true);
  f.buttons[2].dispatch("click");
  f.intervals[0].callback();
  assert.equal(controller.tier, "balanced");
  assert.equal(samples, 0);
});
