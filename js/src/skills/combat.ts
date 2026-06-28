// stats.*, damage.*, status.*, and combat.* skills — health, stats, status effects, and combat.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// CLOSURE WIRING (mirrors terrain.ts): the SkillDefinitions are built INSIDE
// registerCombatSkills, closing over the local StatsManager + CombatManager. There is no
// `ctx.world.statsManager` — the managers live in the registry's closure (a fresh replay
// registry starts empty and rebuilds state by re-invoking the recorded skills).
//
// DETERMINISM: combat is RNG-FREE. No Date.now / Math.random / performance.now. Status-effect
// ids come from a monotonic seq (deterministic). The OPTIONAL crit on combat.melee/combat.ranged
// is derived by a PURE hash of (ctx.tick, attacker id, target id) — never a random draw — so a
// replay at the same tick with the same ids recomputes the identical crit, bit-for-bit. Defend
// stances expire by TICK (ctx.tick), so replay re-derives the same active window.

import { z } from "../../build/zod.bundle.mjs";
import type { ExecutionContext, SkillDefinition, SkillRegistry } from "./registry.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Sim ticks per second — converts the agent-facing `duration` (seconds) on combat.defend
 *  into a deterministic tick-count expiry window (ctx.tick + duration·rate). */
const TICKS_PER_SECOND = 60;

/** A data-driven action the agent attaches to a stat via stats.onZero. The engine/host
 *  fires it (we surface it as an event) when the stat reaches zero — behaviour is the
 *  agent's descriptor, not hardcoded here. */
export interface OnZeroAction {
  type: "emit" | "setState" | "spawn" | "destroy" | "audio" | "animation" | "custom";
  target?: string;
  data: Record<string, unknown>;
}

export interface StatDef {
  name: string;
  value: number;
  maxValue: number;
  minValue: number;
  config?: Record<string, unknown>;
  /** Agent-authored action fired when this stat reaches zero (death, depletion). */
  onZero?: OnZeroAction;
}

export interface StatusEffect {
  id: string;
  type: string;
  duration: number;
  elapsed: number;
  magnitude: number;
  tickInterval?: number;
  onApply?: string;
  onRemove?: string;
  onTick?: string;
  config?: Record<string, unknown>;
}

export interface EntityStats {
  entity: string;
  stats: Map<string, StatDef>;
  statusEffects: StatusEffect[];
}

/** Outcome of a stat mutation: the new clamped value plus the onZero action that fired
 *  on this mutation (null when none). The handler emits the fired descriptor. */
export interface StatChange {
  value: number;
  fired: OnZeroAction | null;
}

export class StatsManager {
  private readonly entityStats = new Map<string, EntityStats>();
  private seq = 0;

  createStats(entity: string, stats: { name: string; value: number; maxValue?: number; minValue?: number; config?: Record<string, unknown> }[]): EntityStats {
    const es: EntityStats = { entity, stats: new Map(), statusEffects: [] };
    for (const s of stats) {
      es.stats.set(s.name, { name: s.name, value: s.value, maxValue: s.maxValue ?? s.value, minValue: s.minValue ?? 0, config: s.config });
    }
    this.entityStats.set(entity, es);
    return es;
  }

  get(entity: string): EntityStats | undefined {
    return this.entityStats.get(entity);
  }

  getStat(entity: string, statName: string): StatDef | undefined {
    return this.entityStats.get(entity)?.stats.get(statName);
  }

  /** Attach an onZero action descriptor to a stat. Returns false if the stat is absent. */
  setOnZero(entity: string, statName: string, action: OnZeroAction): boolean {
    const stat = this.entityStats.get(entity)?.stats.get(statName);
    if (stat === undefined) return false;
    stat.onZero = action;
    return true;
  }

  /** Apply a delta to a stat. Clamps to [min,max] when `clamp` (default). Fires the stat's
   *  onZero action when this mutation crosses DOWN to the floor (value <= minValue, having
   *  been above it before) — returned for the handler to emit. */
  modifyStat(entity: string, statName: string, delta: number, clamp = true): StatChange | undefined {
    const es = this.entityStats.get(entity);
    if (es === undefined) return undefined;
    const stat = es.stats.get(statName);
    if (stat === undefined) return undefined;
    const prev = stat.value;
    const raw = prev + delta;
    stat.value = clamp ? Math.max(stat.minValue, Math.min(stat.maxValue, raw)) : raw;
    const fired = (stat.value <= stat.minValue && prev > stat.minValue && stat.onZero !== undefined) ? stat.onZero : null;
    return { value: stat.value, fired };
  }

  setStat(entity: string, statName: string, value: number): number | undefined {
    const es = this.entityStats.get(entity);
    if (es === undefined) return undefined;
    const stat = es.stats.get(statName);
    if (stat === undefined) return undefined;
    stat.value = Math.max(stat.minValue, Math.min(stat.maxValue, value));
    return stat.value;
  }

  applyStatusEffect(entity: string, effect: Omit<StatusEffect, "id" | "elapsed">): string {
    const es = this.entityStats.get(entity);
    if (es === undefined) return "";
    const id = `status_${this.seq++}`;
    es.statusEffects.push({ ...effect, id, elapsed: 0 });
    return id;
  }

  removeStatusEffect(entity: string, effectId: string): boolean {
    const es = this.entityStats.get(entity);
    if (es === undefined) return false;
    const idx = es.statusEffects.findIndex((e) => e.id === effectId);
    if (idx === -1) return false;
    es.statusEffects.splice(idx, 1);
    return true;
  }

  listStatusEffects(entity: string): StatusEffect[] {
    return this.entityStats.get(entity)?.statusEffects ?? [];
  }

  tickStatusEffects(dtMs: number): { entity: string; effectId: string; expired: boolean }[] {
    const results: { entity: string; effectId: string; expired: boolean }[] = [];
    for (const [entity, es] of this.entityStats) {
      for (const effect of es.statusEffects) {
        effect.elapsed += dtMs;
        if (effect.elapsed >= effect.duration * 1000) {
          results.push({ entity, effectId: effect.id, expired: true });
        }
      }
      es.statusEffects = es.statusEffects.filter((e) => e.elapsed < e.duration * 1000);
    }
    return results;
  }
}

/** A live defensive stance (combat.defend): reduces incoming damage until it expires by tick. */
export interface DefendStance {
  damageReduction: number;
  reflectChance: number;
  expiresTick: number;
}

/** Outcome of applying damage: effective damage dealt, remaining HP, whether the target was
 *  killed, and the onZero action fired on the killing blow (null otherwise). */
export interface DamageResult {
  damage: number;
  remaining: number;
  killed: boolean;
  fired: OnZeroAction | null;
}

export class CombatManager {
  private readonly statsManager: StatsManager;
  private readonly stances = new Map<string, DefendStance>();

  constructor(statsManager: StatsManager) {
    this.statsManager = statsManager;
  }

  /** Record a defensive stance for an entity, expiring at `expiresTick` (deterministic). */
  setDefend(entity: string, damageReduction: number, reflectChance: number, expiresTick: number): void {
    this.stances.set(entity, { damageReduction, reflectChance, expiresTick });
  }

  /** The active stance for an entity at `currentTick`, or undefined (expired stances are
   *  dropped lazily — purely tick-driven, so replay reproduces the same window). */
  activeStance(entity: string, currentTick: number): DefendStance | undefined {
    const s = this.stances.get(entity);
    if (s === undefined) return undefined;
    if (currentTick >= s.expiresTick) {
      this.stances.delete(entity);
      return undefined;
    }
    return s;
  }

  applyDamage(targetEntity: string, amount: number, _type: string, currentTick: number, _attackerEntity?: string): DamageResult {
    const es = this.statsManager.get(targetEntity);
    if (es === undefined) return { damage: 0, remaining: 0, killed: false, fired: null };

    // Defense stat reduction (flat, floored at 1 so a hit always lands).
    let effectiveDamage = amount;
    const defense = es.stats.get("defense");
    if (defense !== undefined) {
      effectiveDamage = Math.max(1, amount - defense.value * 0.5);
    }
    // Active defensive stance further reduces incoming damage.
    const stance = this.activeStance(targetEntity, currentTick);
    if (stance !== undefined) {
      effectiveDamage = effectiveDamage * (1 - stance.damageReduction);
    }

    const hp = es.stats.get("hp") ?? es.stats.get("health");
    if (hp === undefined) return { damage: effectiveDamage, remaining: 0, killed: false, fired: null };

    const change = this.statsManager.modifyStat(targetEntity, hp.name, -effectiveDamage);
    const value = change?.value ?? 0;
    return { damage: effectiveDamage, remaining: Math.max(0, value), killed: value <= hp.minValue, fired: change?.fired ?? null };
  }

  heal(targetEntity: string, amount: number): { healed: number; remaining: number } {
    const es = this.statsManager.get(targetEntity);
    if (es === undefined) return { healed: 0, remaining: 0 };
    const hp = es.stats.get("hp") ?? es.stats.get("health");
    if (hp === undefined) return { healed: 0, remaining: 0 };
    const before = hp.value;
    const change = this.statsManager.modifyStat(targetEntity, hp.name, amount);
    const after = change?.value ?? before;
    return { healed: after - before, remaining: after }; // ACTUAL clamped delta, not the request
  }
}

// ---- Deterministic crit (pure hash, NO RNG) ----

/** FNV-1a 32-bit hash of a string (pure, deterministic). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic crit roll in [0,1) from (tick, attacker, target). Same inputs → same roll,
 *  so replay recomputes identical crits without any RNG. */
function critRoll(tick: number, attacker: string, target: string): number {
  return hash32(`${tick}|${attacker}|${target}`) / 0x100000000;
}

/** Read a finite number from agent config, else a default. */
function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

// ---- Schemas (closure-free; the SkillDefinitions that use them live in registerCombatSkills) ----

const createStatsInput = z.object({
  entity: z.string(),
  stats: z.array(z.object({
    name: z.string().min(1),
    value: z.number(),
    maxValue: z.number().optional().describe("Maximum value (defaults to initial value)."),
    minValue: z.number().optional().describe("Minimum value (defaults to 0)."),
    config: z.record(z.string(), z.unknown()).optional().describe("Custom stat configuration (regen rate, display name, etc.)."),
  })).min(1).describe("Stats to create (hp, mana, stamina, strength, defense, etc.)."),
  meta: MetaField,
});

const getStatInput = z.object({
  entity: z.string(),
  statName: z.string().min(1),
  meta: MetaField,
});

const modifyStatInput = z.object({
  entity: z.string(),
  statName: z.string().min(1),
  delta: z.number().describe("Amount to add (positive) or subtract (negative)."),
  clamp: z.boolean().default(true).describe("Whether to clamp to min/max (default true)."),
  meta: MetaField,
});

const onZeroActionSchema = z.object({
  type: z.enum(["emit", "setState", "spawn", "destroy", "audio", "animation", "custom"]),
  target: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
}).describe("Action to execute when stat reaches zero (typically: death, depletion).");

const onZeroStatInput = z.object({
  entity: z.string(),
  statName: z.string().min(1),
  action: onZeroActionSchema,
  meta: MetaField,
});

const applyDamageInput = z.object({
  targetEntity: z.string(),
  amount: z.number().positive().describe("Base damage amount."),
  type: z.enum(["physical", "magic", "fire", "ice", "lightning", "poison", "custom"]).default("physical").describe("Damage type (affects resistances/weaknesses)."),
  attackerEntity: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom damage data (crit chance, armor penetration, etc.)."),
  meta: MetaField,
});

const healInput = z.object({
  targetEntity: z.string(),
  amount: z.number().positive().describe("Heal amount."),
  meta: MetaField,
});

const applyStatusInput = z.object({
  targetEntity: z.string(),
  type: z.enum(["poison", "stun", "slow", "burn", "freeze", "buff", "shield", "custom"]).describe("Status effect type."),
  duration: z.number().positive().describe("Duration in seconds."),
  magnitude: z.number().default(1).describe("Effect magnitude (damage per tick, slow percentage, etc.)."),
  tickInterval: z.number().positive().optional().describe("Tick interval in ms (for periodic effects like poison)."),
  onApply: z.string().optional().describe("Event to emit on apply."),
  onRemove: z.string().optional().describe("Event to emit on removal."),
  onTick: z.string().optional().describe("Event to emit each tick."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom status effect data (agent-defined behavior parameters)."),
  meta: MetaField,
});

const removeStatusInput = z.object({
  targetEntity: z.string(),
  effectId: z.string(),
  meta: MetaField,
});

const listStatusInput = z.object({
  targetEntity: z.string(),
  meta: MetaField,
});

const meleeInput = z.object({
  attackerEntity: z.string(),
  targetEntity: z.string().optional().describe("Target entity. If omitted, no auto-target is performed (returns hit:false)."),
  damage: z.number().positive().describe("Base melee damage."),
  knockback: z.number().min(0).default(0).describe("Knockback force."),
  range: z.number().positive().default(2).describe("Melee attack range."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom melee data (critChance 0-1, critMultiplier, hit sound, animation, etc.)."),
  meta: MetaField,
});

const rangedInput = z.object({
  attackerEntity: z.string(),
  targetEntity: z.string().optional(),
  direction: Vec3.optional().describe("Projectile direction. If omitted, fires toward targetEntity."),
  damage: z.number().positive().describe("Base projectile damage."),
  speed: z.number().positive().default(20).describe("Projectile speed (world units/second)."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom projectile data (critChance 0-1, critMultiplier, visual effect, etc.)."),
  meta: MetaField,
});

const defendInput = z.object({
  entity: z.string(),
  duration: z.number().positive().default(1).describe("Defend stance duration in seconds."),
  damageReduction: z.number().min(0).max(1).default(0.5).describe("Damage reduction factor (0 = none, 1 = immune)."),
  reflectChance: z.number().min(0).max(1).default(0).describe("Chance to reflect incoming damage (0-1)."),
  meta: MetaField,
});

/**
 * Register the stats/damage/status/combat skills bound to a StatsManager + CombatManager.
 * The skill handlers CLOSE OVER these managers (no ctx.world.statsManager). Returns the
 * managers so the core wiring can expose them (core.combat.statsManager / .combatManager).
 */
export function registerCombatSkills(registry: SkillRegistry, opts?: { statsManager?: StatsManager; combatManager?: CombatManager }): { statsManager: StatsManager; combatManager: CombatManager } {
  const statsMgr = opts?.statsManager ?? new StatsManager();
  const combatMgr = opts?.combatManager ?? new CombatManager(statsMgr);

  /** Surface a fired onZero action descriptor as an event (the engine/host acts on it;
   *  behaviour is the agent's descriptor, never hardcoded here). No-op when nothing fired. */
  function fireOnZero(ctx: ExecutionContext, entity: string, statName: string, fired: OnZeroAction | null): void {
    if (fired === null) return;
    ctx.emit("stats.onZero.fired", { entity, statName, action: fired });
  }

  // ---- Stats skills ----

  const createStats: SkillDefinition<z.infer<typeof createStatsInput>, { ok: boolean }> = {
    name: "stats.create",
    version: "1.0.0",
    description: "Create a stat block on an entity with named stats (HP, stamina, mana, strength, defense, etc.). Each stat has a value, max, and min.",
    category: "stats",
    permissions: ["stats.configure"],
    input: createStatsInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      statsMgr.createStats(input.entity, input.stats);
      ctx.emit("stats.created", { entity: input.entity, stats: input.stats.map((s) => s.name), ...input.meta });
      return { ok: true };
    },
  };

  const getStat: SkillDefinition<z.infer<typeof getStatInput>, { value: number; maxValue: number; minValue: number }> = {
    name: "stats.get",
    version: "1.0.0",
    description: "Get the current value, max, and min of a stat on an entity.",
    category: "stats",
    permissions: ["stats.read"],
    input: getStatInput,
    output: z.object({ value: z.number(), maxValue: z.number(), minValue: z.number() }),
    handler: (input) => {
      const stat = statsMgr.getStat(input.entity, input.statName);
      if (stat === undefined) return { value: 0, maxValue: 0, minValue: 0 };
      return { value: stat.value, maxValue: stat.maxValue, minValue: stat.minValue };
    },
  };

  const modifyStat: SkillDefinition<z.infer<typeof modifyStatInput>, { value: number }> = {
    name: "stats.modify",
    version: "1.0.0",
    description: "Modify a stat (add, subtract). Clamps to min/max by default. Fires the stat's onZero action if the change drops it to zero.",
    category: "stats",
    permissions: ["stats.write"],
    input: modifyStatInput,
    output: z.object({ value: z.number() }),
    handler: (input, ctx) => {
      const change = statsMgr.modifyStat(input.entity, input.statName, input.delta, input.clamp);
      if (change === undefined) return { value: 0 };
      ctx.emit("stats.modified", { entity: input.entity, statName: input.statName, delta: input.delta, value: change.value, ...input.meta });
      fireOnZero(ctx, input.entity, input.statName, change.fired);
      return { value: change.value };
    },
  };

  const onZeroStat: SkillDefinition<z.infer<typeof onZeroStatInput>, { ok: boolean }> = {
    name: "stats.onZero",
    version: "1.0.0",
    description: "Attach a data-driven action to execute when a stat reaches zero (death, depletion, etc.). Stored on the stat block and fired (as stats.onZero.fired) when damage/modify drops the stat to zero.",
    category: "stats",
    permissions: ["stats.configure"],
    input: onZeroStatInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = statsMgr.setOnZero(input.entity, input.statName, input.action);
      ctx.emit("stats.onZero.attached", { entity: input.entity, statName: input.statName, actionType: input.action.type, ok, ...input.meta });
      return { ok };
    },
  };

  // ---- Damage skills ----

  const applyDamage: SkillDefinition<z.infer<typeof applyDamageInput>, { damage: number; remaining: number; killed: boolean }> = {
    name: "damage.apply",
    version: "1.0.0",
    description: "Apply damage to an entity. Respects the defense stat and any active defend stance. Returns damage dealt, remaining HP, and whether target was killed. Fires the target's onZero action on the killing blow.",
    category: "damage",
    permissions: ["damage.write"],
    input: applyDamageInput,
    output: z.object({ damage: z.number(), remaining: z.number(), killed: z.boolean() }),
    handler: (input, ctx) => {
      const { fired, ...result } = combatMgr.applyDamage(input.targetEntity, input.amount, input.type, ctx.tick, input.attackerEntity);
      ctx.emit("damage.applied", { target: input.targetEntity, amount: input.amount, type: input.type, attacker: input.attackerEntity, ...input.meta, ...result });
      fireOnZero(ctx, input.targetEntity, "hp", fired);
      return result;
    },
  };

  const heal: SkillDefinition<z.infer<typeof healInput>, { healed: number; remaining: number }> = {
    name: "damage.heal",
    version: "1.0.0",
    description: "Apply healing to an entity (restores HP). Returns the ACTUAL clamped amount healed and the remaining HP.",
    category: "damage",
    permissions: ["damage.write"],
    input: healInput,
    output: z.object({ healed: z.number(), remaining: z.number() }),
    handler: (input, ctx) => {
      const result = combatMgr.heal(input.targetEntity, input.amount);
      ctx.emit("damage.healed", { target: input.targetEntity, amount: input.amount, ...input.meta, ...result });
      return result;
    },
  };

  // ---- Status skills ----

  const applyStatus: SkillDefinition<z.infer<typeof applyStatusInput>, { effectId: string }> = {
    name: "status.apply",
    version: "1.0.0",
    description: "Apply a status effect to an entity (poison, stun, slow, buff, shield, etc.) with duration and magnitude.",
    category: "status",
    permissions: ["status.write"],
    input: applyStatusInput,
    output: z.object({ effectId: z.string() }),
    handler: (input, ctx) => {
      const id = statsMgr.applyStatusEffect(input.targetEntity, {
        type: input.type,
        duration: input.duration,
        magnitude: input.magnitude,
        tickInterval: input.tickInterval,
        onApply: input.onApply,
        onRemove: input.onRemove,
        onTick: input.onTick,
        config: input.config,
      });
      ctx.emit("status.applied", { target: input.targetEntity, type: input.type, duration: input.duration, effectId: id, ...input.meta });
      return { effectId: id };
    },
  };

  const removeStatus: SkillDefinition<z.infer<typeof removeStatusInput>, { ok: boolean }> = {
    name: "status.remove",
    version: "1.0.0",
    description: "Remove a status effect from an entity by effect id.",
    category: "status",
    permissions: ["status.write"],
    input: removeStatusInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = statsMgr.removeStatusEffect(input.targetEntity, input.effectId);
      ctx.emit("status.removed", { target: input.targetEntity, effectId: input.effectId, ok, ...input.meta });
      return { ok };
    },
  };

  const listStatus: SkillDefinition<z.infer<typeof listStatusInput>, { effects: { id: string; type: string; duration: number; elapsed: number; magnitude: number }[] }> = {
    name: "status.list",
    version: "1.0.0",
    description: "List active status effects on an entity.",
    category: "status",
    permissions: ["status.read"],
    input: listStatusInput,
    output: z.object({ effects: z.array(z.object({ id: z.string(), type: z.string(), duration: z.number(), elapsed: z.number(), magnitude: z.number() })) }),
    handler: (input) => {
      return { effects: statsMgr.listStatusEffects(input.targetEntity).map((e) => ({ id: e.id, type: e.type, duration: e.duration, elapsed: e.elapsed, magnitude: e.magnitude })) };
    },
  };

  // ---- Combat skills ----

  const meleeCombat: SkillDefinition<z.infer<typeof meleeInput>, { hit: boolean; damage?: number; killed?: boolean; crit?: boolean }> = {
    name: "combat.melee",
    version: "1.0.0",
    description: "Perform a melee attack from an entity toward an explicit target. If targetEntity is omitted, no auto-target is performed and hit:false is returned. Crit (optional config.critChance) is derived deterministically from tick+ids (no RNG).",
    category: "combat",
    permissions: ["combat.write"],
    input: meleeInput,
    output: z.object({ hit: z.boolean(), damage: z.number().optional(), killed: z.boolean().optional(), crit: z.boolean().optional() }),
    handler: (input, ctx) => {
      if (input.targetEntity === undefined) {
        ctx.emit("combat.melee", { attacker: input.attackerEntity, target: null, hit: false, ...input.meta });
        return { hit: false };
      }
      const critChance = num(input.config?.critChance, 0);
      const critMult = num(input.config?.critMultiplier, 2);
      const crit = critChance > 0 && critRoll(ctx.tick, input.attackerEntity, input.targetEntity) < critChance;
      const dmg = crit ? input.damage * critMult : input.damage;
      const { fired, ...result } = combatMgr.applyDamage(input.targetEntity, dmg, "physical", ctx.tick, input.attackerEntity);
      ctx.emit("combat.melee", { attacker: input.attackerEntity, target: input.targetEntity, damage: input.damage, knockback: input.knockback, crit, ...input.meta, ...result });
      fireOnZero(ctx, input.targetEntity, "hp", fired);
      return { hit: true, damage: result.damage, killed: result.killed, crit };
    },
  };

  const rangedCombat: SkillDefinition<z.infer<typeof rangedInput>, { fired: boolean; hit: boolean; damage?: number; killed?: boolean; crit?: boolean }> = {
    name: "combat.ranged",
    version: "1.0.0",
    description: "Fire a ranged attack from an entity. IMPLEMENTATION: an honest IMMEDIATE HIT toward targetEntity via the same damage path as melee (no separate projectile entity); when only a direction is given there is no target to resolve, so it fires into space (hit:false). Crit (optional config.critChance) is deterministic from tick+ids.",
    category: "combat",
    permissions: ["combat.write"],
    input: rangedInput,
    output: z.object({ fired: z.boolean(), hit: z.boolean(), damage: z.number().optional(), killed: z.boolean().optional(), crit: z.boolean().optional() }),
    handler: (input, ctx) => {
      if (input.targetEntity === undefined) {
        // Honest: a direction-only shot has no entity to damage in this immediate-hit model.
        ctx.emit("combat.ranged", { attacker: input.attackerEntity, target: null, direction: input.direction, damage: input.damage, speed: input.speed, hit: false, ...input.meta });
        return { fired: true, hit: false };
      }
      const critChance = num(input.config?.critChance, 0);
      const critMult = num(input.config?.critMultiplier, 2);
      const crit = critChance > 0 && critRoll(ctx.tick, input.attackerEntity, input.targetEntity) < critChance;
      const dmg = crit ? input.damage * critMult : input.damage;
      const { fired, ...result } = combatMgr.applyDamage(input.targetEntity, dmg, "physical", ctx.tick, input.attackerEntity);
      ctx.emit("combat.ranged", { attacker: input.attackerEntity, target: input.targetEntity, damage: input.damage, speed: input.speed, crit, ...input.meta, ...result });
      fireOnZero(ctx, input.targetEntity, "hp", fired);
      return { fired: true, hit: true, damage: result.damage, killed: result.killed, crit };
    },
  };

  const defend: SkillDefinition<z.infer<typeof defendInput>, { ok: boolean; expiresTick: number }> = {
    name: "combat.defend",
    version: "1.0.0",
    description: "Enter a defensive stance that reduces incoming damage on subsequent damage.apply until it expires. Duration is in seconds, converted to a deterministic tick-expiry window (ctx.tick + duration·60).",
    category: "combat",
    permissions: ["combat.write"],
    input: defendInput,
    output: z.object({ ok: z.boolean(), expiresTick: z.number() }),
    handler: (input, ctx) => {
      const expiresTick = ctx.tick + Math.max(1, Math.round(input.duration * TICKS_PER_SECOND));
      combatMgr.setDefend(input.entity, input.damageReduction, input.reflectChance, expiresTick);
      ctx.emit("combat.defend", { entity: input.entity, duration: input.duration, damageReduction: input.damageReduction, reflectChance: input.reflectChance, expiresTick, ...input.meta });
      return { ok: true, expiresTick };
    },
  };

  registry.register(createStats);
  registry.register(getStat);
  registry.register(modifyStat);
  registry.register(onZeroStat);
  registry.register(applyDamage);
  registry.register(heal);
  registry.register(applyStatus);
  registry.register(removeStatus);
  registry.register(listStatus);
  registry.register(meleeCombat);
  registry.register(rangedCombat);
  registry.register(defend);

  return { statsManager: statsMgr, combatManager: combatMgr };
}
