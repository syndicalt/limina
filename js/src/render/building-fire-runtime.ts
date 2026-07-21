/** Deterministic authoritative state for a staged-building hearth fire.
 *
 * This module deliberately owns no Three.js objects. A later render mount supplies a binding
 * which projects the immutable light sample onto engine resources. State advances only in fixed
 * integer ticks; shader time, particle time, light flicker, save/restore, and review sampling can
 * therefore all derive from the same replayable clock instead of wall time.
 */

export const BUILDING_FIRE_SNAPSHOT_SCHEMA = "limina.building-fire-runtime-snapshot/v1" as const;
export const BUILDING_FIRE_TICK_HZ = 60 as const;

const ENVELOPE_SCALE = 1_000_000;
const UINT32_MAX = 0xffff_ffff;

export type BuildingFirePhase = "off" | "igniting" | "burning" | "extinguishing";

export interface BuildingFireParameters {
  readonly ignitionTicks: number;
  readonly extinguishTicks: number;
  readonly lightBaseCandela: number;
  readonly lightFlickerCandela: number;
  readonly lightDistanceM: number;
  readonly lightDecay: 2;
}

export interface BuildingFireLightSample {
  readonly tick: number;
  readonly phase: BuildingFirePhase;
  readonly phaseElapsedTicks: number;
  readonly authoritativeTimeSeconds: number;
  readonly envelope: number;
  readonly flicker01: number;
  readonly intensityCandela: number;
  readonly powerLumens: number;
  readonly distanceM: number;
  readonly decay: 2;
  readonly colorSrgb: readonly [number, number, number];
}

export interface BuildingFireRuntimeSnapshot {
  readonly schema: typeof BUILDING_FIRE_SNAPSHOT_SCHEMA;
  readonly tickHz: typeof BUILDING_FIRE_TICK_HZ;
  readonly seed: number;
  readonly parameters: BuildingFireParameters;
  readonly state: Readonly<{
    tick: number;
    phase: BuildingFirePhase;
    phaseStartedTick: number;
    transitionStartEnvelopeQ: number;
  }>;
}

export interface BuildingFireRuntimeBinding {
  /** Atomically project one authoritative sample onto render resources. */
  apply(sample: Readonly<BuildingFireLightSample>): void;
  /** Release every resource owned by the binding. Called at most once. */
  dispose(): void;
}

export interface BuildingFireRuntimeOptions {
  readonly seed?: number;
  readonly ignitionTicks?: number;
  readonly extinguishTicks?: number;
  readonly lightBaseCandela?: number;
  readonly lightFlickerCandela?: number;
  readonly lightDistanceM?: number;
  readonly binding?: BuildingFireRuntimeBinding;
}

export const BUILDING_FIRE_PARAMETER_LIMITS = Object.freeze({
  ignitionTicks: Object.freeze({ minimum: 1, maximum: 600 }),
  extinguishTicks: Object.freeze({ minimum: 1, maximum: 1_200 }),
  lightBaseCandela: Object.freeze({ minimum: 1, maximum: 8 }),
  lightFlickerCandela: Object.freeze({ minimum: 0, maximum: 0.48 }),
  lightMaximumCandela: 8,
  lightMaximumFlickerFraction: 0.06,
  lightDistanceM: Object.freeze({ minimum: 1.5, maximum: 8 }),
  lightDecay: 2,
} as const);

const DEFAULT_PARAMETERS: BuildingFireParameters = Object.freeze({
  ignitionTicks: 90,
  extinguishTicks: 150,
  lightBaseCandela: 7.4,
  lightFlickerCandela: 0.4,
  lightDistanceM: 5.5,
  lightDecay: 2,
});

interface MutableState {
  tick: number;
  phase: BuildingFirePhase;
  phaseStartedTick: number;
  transitionStartEnvelopeQ: number;
}

const PHASES = new Set<BuildingFirePhase>(["off", "igniting", "burning", "extinguishing"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const expected = new Set(required);
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new Error(`${label}.${key} is unsupported`);
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be finite in [${minimum}, ${maximum}]`);
  }
  return value;
}

function parameters(input: BuildingFireRuntimeOptions): BuildingFireParameters {
  const ignitionTicks = integer(input.ignitionTicks ?? DEFAULT_PARAMETERS.ignitionTicks,
    BUILDING_FIRE_PARAMETER_LIMITS.ignitionTicks.minimum, BUILDING_FIRE_PARAMETER_LIMITS.ignitionTicks.maximum, "ignitionTicks");
  const extinguishTicks = integer(input.extinguishTicks ?? DEFAULT_PARAMETERS.extinguishTicks,
    BUILDING_FIRE_PARAMETER_LIMITS.extinguishTicks.minimum, BUILDING_FIRE_PARAMETER_LIMITS.extinguishTicks.maximum, "extinguishTicks");
  const lightBaseCandela = finite(input.lightBaseCandela ?? DEFAULT_PARAMETERS.lightBaseCandela,
    BUILDING_FIRE_PARAMETER_LIMITS.lightBaseCandela.minimum, BUILDING_FIRE_PARAMETER_LIMITS.lightBaseCandela.maximum, "lightBaseCandela");
  const lightFlickerCandela = finite(input.lightFlickerCandela ?? DEFAULT_PARAMETERS.lightFlickerCandela,
    BUILDING_FIRE_PARAMETER_LIMITS.lightFlickerCandela.minimum, BUILDING_FIRE_PARAMETER_LIMITS.lightFlickerCandela.maximum, "lightFlickerCandela");
  if (lightFlickerCandela > lightBaseCandela * BUILDING_FIRE_PARAMETER_LIMITS.lightMaximumFlickerFraction) {
    throw new RangeError(`fire light flicker exceeds ${(BUILDING_FIRE_PARAMETER_LIMITS.lightMaximumFlickerFraction * 100).toFixed(0)}% of base candela`);
  }
  if (lightBaseCandela + lightFlickerCandela > BUILDING_FIRE_PARAMETER_LIMITS.lightMaximumCandela) {
    throw new RangeError(`fire light peak exceeds ${BUILDING_FIRE_PARAMETER_LIMITS.lightMaximumCandela} candela`);
  }
  const lightDistanceM = finite(input.lightDistanceM ?? DEFAULT_PARAMETERS.lightDistanceM,
    BUILDING_FIRE_PARAMETER_LIMITS.lightDistanceM.minimum, BUILDING_FIRE_PARAMETER_LIMITS.lightDistanceM.maximum, "lightDistanceM");
  return Object.freeze({ ignitionTicks, extinguishTicks, lightBaseCandela, lightFlickerCandela, lightDistanceM, lightDecay: 2 });
}

function parametersFromSnapshot(value: unknown): BuildingFireParameters {
  const source = record(value, "fire snapshot parameters");
  exactKeys(source, ["ignitionTicks", "extinguishTicks", "lightBaseCandela", "lightFlickerCandela", "lightDistanceM", "lightDecay"], "fire snapshot parameters");
  if (source.lightDecay !== 2) throw new RangeError("fire snapshot parameters.lightDecay must equal 2");
  return parameters(source as unknown as BuildingFireRuntimeOptions);
}

function sameParameters(left: BuildingFireParameters, right: BuildingFireParameters): boolean {
  return left.ignitionTicks === right.ignitionTicks && left.extinguishTicks === right.extinguishTicks
    && left.lightBaseCandela === right.lightBaseCandela && left.lightFlickerCandela === right.lightFlickerCandela
    && left.lightDistanceM === right.lightDistanceM && left.lightDecay === right.lightDecay;
}

function smoothstep01(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function triangle01(tick: number, period: number, phase: number): number {
  const position = ((tick + phase) % period + period) % period;
  const unit = position / period;
  return unit < 0.5 ? unit * 2 : 2 - unit * 2;
}

function flicker(seed: number, tick: number): number {
  // Three incommensurate, tick-indexed triangle waves avoid wall time, random state, and harsh
  // frame-white-noise while remaining exactly reconstructible from (seed,tick).
  const a = triangle01(tick, 17, seed % 17);
  const b = triangle01(tick, 29, (seed >>> 8) % 29);
  const c = triangle01(tick, 43, (seed >>> 16) % 43);
  return a * 0.5 + b * 0.32 + c * 0.18;
}

function envelope(state: Readonly<MutableState>, values: BuildingFireParameters): number {
  const elapsed = state.tick - state.phaseStartedTick;
  const start = state.transitionStartEnvelopeQ / ENVELOPE_SCALE;
  if (state.phase === "off") return 0;
  if (state.phase === "burning") return 1;
  if (state.phase === "igniting") return start + (1 - start) * smoothstep01(elapsed / values.ignitionTicks);
  return start * (1 - smoothstep01(elapsed / values.extinguishTicks));
}

function sample(state: Readonly<MutableState>, seed: number, values: BuildingFireParameters): Readonly<BuildingFireLightSample> {
  const amount = envelope(state, values), flicker01 = flicker(seed, state.tick);
  const intensityCandela = amount * (values.lightBaseCandela + values.lightFlickerCandela * flicker01);
  const warmth = 0.34 + flicker01 * 0.16;
  return Object.freeze({
    tick: state.tick,
    phase: state.phase,
    phaseElapsedTicks: state.tick - state.phaseStartedTick,
    authoritativeTimeSeconds: state.tick / BUILDING_FIRE_TICK_HZ,
    envelope: amount,
    flicker01,
    intensityCandela,
    powerLumens: intensityCandela * Math.PI * 4,
    distanceM: values.lightDistanceM,
    decay: 2 as const,
    colorSrgb: Object.freeze([1, warmth, 0.09 + flicker01 * 0.09] as [number, number, number]),
  });
}

export function validateBuildingFireRuntimeSnapshot(value: unknown): Readonly<BuildingFireRuntimeSnapshot> {
  const source = record(value, "fire snapshot");
  exactKeys(source, ["schema", "tickHz", "seed", "parameters", "state"], "fire snapshot");
  if (source.schema !== BUILDING_FIRE_SNAPSHOT_SCHEMA) throw new Error("unsupported building fire snapshot schema");
  if (source.tickHz !== BUILDING_FIRE_TICK_HZ) throw new Error(`building fire snapshot tickHz must equal ${BUILDING_FIRE_TICK_HZ}`);
  const seed = integer(source.seed, 0, UINT32_MAX, "fire snapshot seed");
  const values = parametersFromSnapshot(source.parameters);
  const stateSource = record(source.state, "fire snapshot state");
  exactKeys(stateSource, ["tick", "phase", "phaseStartedTick", "transitionStartEnvelopeQ"], "fire snapshot state");
  const tick = integer(stateSource.tick, 0, Number.MAX_SAFE_INTEGER, "fire snapshot state.tick");
  const phaseStartedTick = integer(stateSource.phaseStartedTick, 0, tick, "fire snapshot state.phaseStartedTick");
  if (!PHASES.has(stateSource.phase as BuildingFirePhase)) throw new Error("fire snapshot state.phase is unsupported");
  const transitionStartEnvelopeQ = integer(stateSource.transitionStartEnvelopeQ, 0, ENVELOPE_SCALE,
    "fire snapshot state.transitionStartEnvelopeQ");
  const phase = stateSource.phase as BuildingFirePhase;
  const phaseElapsedTicks = tick - phaseStartedTick;
  if ((phase === "igniting" && phaseElapsedTicks >= values.ignitionTicks)
    || (phase === "extinguishing" && phaseElapsedTicks >= values.extinguishTicks)) {
    throw new Error(`fire snapshot ${phase} state has crossed its canonical transition boundary`);
  }
  if ((phase === "off" && transitionStartEnvelopeQ !== 0) || (phase === "burning" && transitionStartEnvelopeQ !== ENVELOPE_SCALE)) {
    throw new Error(`fire snapshot ${phase} state carries an invalid transition envelope`);
  }
  const state = Object.freeze({ tick, phase, phaseStartedTick, transitionStartEnvelopeQ });
  return Object.freeze({ schema: BUILDING_FIRE_SNAPSHOT_SCHEMA, tickHz: BUILDING_FIRE_TICK_HZ, seed,
    parameters: values, state });
}

export class BuildingFireRuntime {
  readonly seed: number;
  readonly parameters: BuildingFireParameters;
  #state: MutableState = { tick: 0, phase: "off", phaseStartedTick: 0, transitionStartEnvelopeQ: 0 };
  #binding: BuildingFireRuntimeBinding | undefined;
  #disposed = false;

  constructor(options: BuildingFireRuntimeOptions = {}) {
    this.seed = integer(options.seed ?? 0x48454152, 0, UINT32_MAX, "fire seed");
    this.parameters = parameters(options);
    if (options.binding !== undefined
      && (typeof options.binding.apply !== "function" || typeof options.binding.dispose !== "function")) {
      throw new TypeError("fire runtime binding must expose apply() and dispose()");
    }
    this.#binding = options.binding;
    try {
      this.#binding?.apply(this.lightSample());
    } catch (error) {
      try { this.#binding?.dispose(); } catch (cleanup) {
        throw new AggregateError([error, cleanup], "fire runtime binding initialization failed and cleanup failed");
      }
      this.#binding = undefined;
      this.#disposed = true;
      throw error;
    }
  }

  get disposed(): boolean { return this.#disposed; }
  get phase(): BuildingFirePhase { this.#live(); return this.#state.phase; }
  get tick(): number { this.#live(); return this.#state.tick; }

  #live(): void {
    if (this.#disposed) throw new Error("building fire runtime is disposed");
  }

  #publish(next: MutableState): Readonly<BuildingFireLightSample> {
    const nextSample = sample(next, this.seed, this.parameters);
    this.#binding?.apply(nextSample);
    this.#state = next;
    return nextSample;
  }

  lightSample(): Readonly<BuildingFireLightSample> {
    this.#live();
    return sample(this.#state, this.seed, this.parameters);
  }

  start(): boolean {
    this.#live();
    if (this.#state.phase === "igniting" || this.#state.phase === "burning") return false;
    const startEnvelope = envelope(this.#state, this.parameters);
    this.#publish({ ...this.#state, phase: "igniting", phaseStartedTick: this.#state.tick,
      transitionStartEnvelopeQ: Math.round(startEnvelope * ENVELOPE_SCALE) });
    return true;
  }

  extinguish(): boolean {
    this.#live();
    if (this.#state.phase === "off" || this.#state.phase === "extinguishing") return false;
    const startEnvelope = envelope(this.#state, this.parameters);
    this.#publish({ ...this.#state, phase: "extinguishing", phaseStartedTick: this.#state.tick,
      transitionStartEnvelopeQ: Math.round(startEnvelope * ENVELOPE_SCALE) });
    return true;
  }

  advanceTicks(count = 1): Readonly<BuildingFireLightSample> {
    this.#live();
    integer(count, 0, Number.MAX_SAFE_INTEGER - this.#state.tick, "fire advance tick count");
    let remaining = count;
    const next = { ...this.#state };
    while (remaining > 0) {
      if (next.phase === "off" || next.phase === "burning") {
        next.tick += remaining;
        remaining = 0;
        break;
      }
      const duration = next.phase === "igniting" ? this.parameters.ignitionTicks : this.parameters.extinguishTicks;
      const boundary = next.phaseStartedTick + duration;
      const toBoundary = boundary - next.tick;
      if (remaining < toBoundary) {
        next.tick += remaining;
        remaining = 0;
        break;
      }
      next.tick = boundary;
      remaining -= toBoundary;
      if (next.phase === "igniting") {
        next.phase = "burning";
        next.phaseStartedTick = next.tick;
        next.transitionStartEnvelopeQ = ENVELOPE_SCALE;
      } else {
        next.phase = "off";
        next.phaseStartedTick = next.tick;
        next.transitionStartEnvelopeQ = 0;
      }
    }
    return this.#publish(next);
  }

  snapshot(): Readonly<BuildingFireRuntimeSnapshot> {
    this.#live();
    return Object.freeze({
      schema: BUILDING_FIRE_SNAPSHOT_SCHEMA,
      tickHz: BUILDING_FIRE_TICK_HZ,
      seed: this.seed,
      parameters: this.parameters,
      state: Object.freeze({ ...this.#state }),
    });
  }

  restore(value: unknown): Readonly<BuildingFireLightSample> {
    this.#live();
    const restored = validateBuildingFireRuntimeSnapshot(value);
    if (restored.seed !== this.seed) throw new Error("fire snapshot seed does not match runtime authority");
    if (!sameParameters(restored.parameters, this.parameters)) throw new Error("fire snapshot parameters do not match runtime authority");
    return this.#publish({ ...restored.state });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const binding = this.#binding;
    this.#binding = undefined;
    binding?.dispose();
  }
}
