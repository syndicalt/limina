// GAME HUD — a render-only, screen-anchored overlay that mirrors live player +
// quest state onto the A4 UI surface. A sibling of character_model.ts /
// locomotion.ts: same world/ helper style, same RENDER-ONLY contract.
//
//   const hud = new GameHud({ uiManager, world, managers, options });
//   hud.init();                 // create the HUD panels (top-left vitals, top-right quest)
//   hud.update(playerEntity);   // read CURRENT manager state -> refresh the panel lines
//   hud.setQuest(questId);      // pin which quest the tracker follows (or auto-track)
//   hud.dispose();              // remove the panels
//
// It READS from the closure-owned game managers core exposes (the same instances
// the skills mutate) and WRITES only to the UiManager:
//   • StatsManager        (core.combat.statsManager)    — the player's HP stat.
//   • QuestManager        (core.quest.questManager)      — the tracked/active quest
//                                                          name + per-objective counts.
//   • InventoryManager    (core.inventory.inventoryManager) — optional key item counts.
//   • GameStateManager    (core.gamestate.gameStateManager) — optional counters.
//
// DETERMINISM / SAFETY: this is RENDER-ONLY. It never records sim/log state, never
// touches physics/ECS, and contains no Date.now / Math.random / performance.now — it
// reads managers and pushes lines to the UI, so it can never perturb the deterministic
// sim or replay. Every read is null-safe: a missing stat shows "HP  --" and an absent
// quest shows the no-quest line rather than throwing. update() is cheap (the Panel
// re-composites only when its content actually changes) and safe to call every frame.

import type { ScreenCorner } from "../ui/anchor.ts";
import type { TextStyle } from "../ui/compositor.ts";
import type { UiManager } from "../ui/manager.ts";
import type { WorldContext } from "../skills/registry.ts";
import type { StatsManager } from "../skills/combat.ts";
import type { QuestManager, QuestInstance } from "../skills/quest.ts";
import type { InventoryManager } from "../skills/inventory.ts";
import type { GameStateManager } from "../skills/gamestate.ts";

/** The read sources the HUD pulls live state from — pass the closure-owned managers
 *  core exposes (core.combat.statsManager, core.quest.questManager, …). Every field is
 *  optional: an absent manager simply drops the section it feeds (graceful, no throw). */
export interface GameHudManagers {
  stats?: StatsManager;
  quest?: QuestManager;
  inventory?: InventoryManager;
  gamestate?: GameStateManager;
}

/** A key inventory item to surface on the vitals panel (e.g. potions, keys). */
export interface GameHudItemSpec {
  itemId: string;
  /** Display label; defaults to the itemId when omitted. */
  label?: string;
}

/** Optional presentation/config for the HUD (sane defaults for every field). */
export interface GameHudOptions {
  /** The HP stat name to read; falls back to "health" when absent. Default "hp". */
  hpStat?: string;
  /** Corner the vitals panel pins to. Default "top-left". */
  vitalsCorner?: ScreenCorner;
  /** Corner the quest tracker pins to. Default "top-right". */
  questCorner?: ScreenCorner;
  /** Vitals panel title. Default "VITALS". */
  vitalsTitle?: string;
  /** Quest tracker title shown when NO quest is tracked. Default "QUEST". */
  questTitle?: string;
  /** Fixed pixel width for the vitals panel (omit to auto-size). */
  vitalsWidth?: number;
  /** Fixed pixel width for the quest panel (omit to auto-size). */
  questWidth?: number;
  /** Panel margin from the anchored corner, in px. Default [16, 16]. */
  marginPx?: [number, number];
  /** Shared style override applied to both panels. */
  style?: TextStyle;
  /** Key inventory item counts to show on the vitals panel (needs InventoryManager). */
  items?: GameHudItemSpec[];
  /** Game counters to show on the vitals panel (needs GameStateManager). */
  counters?: string[];
  /** Line shown when there is no tracked/active quest. Default "No active quest". */
  noQuestText?: string;
  /** Optional hint appended to the quest tracker once EVERY objective is complete but the
   *  quest is still active (i.e. it needs turning in) — e.g. "Return to the keeper". Makes
   *  the turn-in step legible instead of an invisible proximity win. Omit = no hint. */
  turnInHint?: string;
}

/** Constructor bundle: the UI surface to author against, the world (for its scene),
 *  the read-source managers, and optional presentation config. */
export interface GameHudInit {
  uiManager: UiManager;
  world: WorldContext;
  managers: GameHudManagers;
  options?: GameHudOptions;
}

/** Which panel a reader is asking about. */
export type GameHudPanel = "vitals" | "quest";

/** A resolved, display-ready view of the tracked quest. */
interface ResolvedQuest {
  name: string;
  objectives: { desc: string; progress: number; required: number }[];
}

/** Fully-resolved internal config (every field present). */
interface ResolvedOptions {
  hpStat: string;
  vitalsCorner: ScreenCorner;
  questCorner: ScreenCorner;
  vitalsTitle: string;
  questTitle: string;
  vitalsWidth: number | undefined;
  questWidth: number | undefined;
  marginPx: [number, number];
  style: TextStyle | undefined;
  items: GameHudItemSpec[];
  counters: string[];
  noQuestText: string;
  turnInHint: string | undefined;
}

/** Format a (possibly fractional / non-finite) stat value for display: integers as-is,
 *  fractions rounded to one decimal, non-finite as the placeholder dash. */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "--";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

/**
 * The screen-anchored game HUD: a top-left player-vitals panel (HP, optional item /
 * counter readouts) and a top-right quest tracker (active quest name + objective
 * progress). Reads the live game managers; writes only to the UiManager.
 */
export class GameHud {
  private readonly uiManager: UiManager;
  private readonly world: WorldContext;
  private readonly managers: GameHudManagers;
  private readonly opts: ResolvedOptions;

  private vitalsHandle: string | undefined;
  private questHandle: string | undefined;
  /** The quest the tracker is pinned to; undefined = auto-track the entity's tracked/active quest. */
  private trackedQuestId: string | undefined;

  // Last lines/title actually pushed to each panel — exposed for hosts/tests to read
  // the rendered HUD content (the Panel does not expose its composited text).
  private lastVitals: string[] = [];
  private lastQuest: string[] = [];
  private lastQuestTitle: string;

  constructor(init: GameHudInit) {
    this.uiManager = init.uiManager;
    this.world = init.world;
    this.managers = init.managers;
    const o = init.options ?? {};
    this.opts = {
      hpStat: o.hpStat ?? "hp",
      vitalsCorner: o.vitalsCorner ?? "top-left",
      questCorner: o.questCorner ?? "top-right",
      vitalsTitle: o.vitalsTitle ?? "VITALS",
      questTitle: o.questTitle ?? "QUEST",
      vitalsWidth: o.vitalsWidth,
      questWidth: o.questWidth,
      marginPx: o.marginPx ?? [16, 16],
      style: o.style,
      items: o.items ?? [],
      counters: o.counters ?? [],
      noQuestText: o.noQuestText ?? "No active quest",
      turnInHint: o.turnInHint,
    };
    this.lastQuestTitle = this.opts.questTitle;
  }

  /** Create the HUD panel(s): a top-left vitals panel and a top-right quest tracker.
   *  Idempotent — a second call while the panels are live is a no-op. */
  init(): void {
    if (this.vitalsHandle !== undefined || this.questHandle !== undefined) return;
    const scene = this.world.scene;
    const vitals = this.uiManager.create(scene, "hudPanel", {
      anchor: { kind: "screen", corner: this.opts.vitalsCorner, marginPx: this.opts.marginPx },
      title: this.opts.vitalsTitle,
      lines: this.lastVitals.length > 0 ? this.lastVitals : [`HP  --`],
      width: this.opts.vitalsWidth,
      style: this.opts.style,
    });
    this.vitalsHandle = vitals.handle;
    this.lastVitals = [`HP  --`];

    const quest = this.uiManager.create(scene, "hudPanel", {
      anchor: { kind: "screen", corner: this.opts.questCorner, marginPx: this.opts.marginPx },
      title: this.opts.questTitle,
      lines: [this.opts.noQuestText],
      width: this.opts.questWidth,
      style: this.opts.style,
    });
    this.questHandle = quest.handle;
    this.lastQuest = [this.opts.noQuestText];
    this.lastQuestTitle = this.opts.questTitle;
  }

  /** Pin which quest the tracker follows. Pass null/undefined to return to auto-tracking
   *  the entity's tracked (or first active) quest. Takes effect on the next update(). */
  setQuest(questId: string | null | undefined): void {
    this.trackedQuestId = questId ?? undefined;
  }

  /** Read CURRENT state from the managers and refresh the panel lines. Cheap (the Panel
   *  re-composites only when the content actually changes) and safe to call every frame.
   *  No-op before init() (no panels to update). */
  update(playerEntity: string): void {
    if (this.vitalsHandle !== undefined) {
      const lines = this.buildVitalsLines(playerEntity);
      this.lastVitals = lines;
      this.uiManager.update(this.vitalsHandle, { lines });
    }
    if (this.questHandle !== undefined) {
      const { title, lines } = this.buildQuestPanel(playerEntity);
      this.lastQuest = lines;
      this.lastQuestTitle = title;
      this.uiManager.update(this.questHandle, { title, lines });
    }
  }

  /** Remove the HUD panel(s) and forget their handles. Safe to call repeatedly. */
  dispose(): void {
    if (this.vitalsHandle !== undefined) {
      this.uiManager.remove(this.vitalsHandle);
      this.vitalsHandle = undefined;
    }
    if (this.questHandle !== undefined) {
      this.uiManager.remove(this.questHandle);
      this.questHandle = undefined;
    }
  }

  // ---- inspection (hosts/tests read the rendered HUD content) -----------------

  /** The live panel handles (undefined before init() / after dispose()). */
  handles(): { vitals: string | undefined; quest: string | undefined } {
    return { vitals: this.vitalsHandle, quest: this.questHandle };
  }

  /** The lines last pushed to a panel (a copy). The Panel does not expose its
   *  composited text, so this is how a host/test reads what the HUD shows. */
  lines(panel: GameHudPanel): string[] {
    return panel === "vitals" ? [...this.lastVitals] : [...this.lastQuest];
  }

  /** The quest tracker's current title (the tracked quest name, or the default). */
  questTitle(): string {
    return this.lastQuestTitle;
  }

  // ---- line builders ----------------------------------------------------------

  /** Build the vitals lines: HP (graceful "--" when the stat is missing), then any
   *  configured key item counts and game counters whose manager is present. */
  private buildVitalsLines(entity: string): string[] {
    const lines: string[] = [];
    const stats = this.managers.stats;
    const stat = stats?.getStat(entity, this.opts.hpStat) ?? stats?.getStat(entity, "health");
    if (stat === undefined) {
      lines.push(`HP  --`);
    } else {
      lines.push(`HP  ${fmtNum(stat.value)} / ${fmtNum(stat.maxValue)}`);
    }

    const inv = this.managers.inventory;
    if (inv !== undefined) {
      for (const it of this.opts.items) {
        const label = it.label ?? it.itemId;
        lines.push(`${label}  ${inv.countItem(entity, it.itemId)}`);
      }
    }

    const gs = this.managers.gamestate;
    if (gs !== undefined) {
      for (const name of this.opts.counters) {
        lines.push(`${name}  ${gs.getCounter(name)}`);
      }
    }
    return lines;
  }

  /** Build the quest tracker title + lines for the tracked/active quest. */
  private buildQuestPanel(entity: string): { title: string; lines: string[] } {
    const resolved = this.resolveQuest(entity);
    if (resolved === undefined) {
      return { title: this.opts.questTitle, lines: [this.opts.noQuestText] };
    }
    const lines: string[] = [];
    for (const o of resolved.objectives) {
      lines.push(o.desc);
      lines.push(`  ${o.progress} / ${o.required}`);
    }
    // A defined quest with no objectives still reads clearly rather than blank.
    if (lines.length === 0) lines.push(this.opts.noQuestText);
    // Turn-in hint: once every objective is satisfied but the quest is still active, tell
    // the player to go turn it in (otherwise the win reads as an invisible proximity event).
    if (
      this.opts.turnInHint !== undefined &&
      resolved.objectives.length > 0 &&
      resolved.objectives.every((o) => o.progress >= o.required)
    ) {
      lines.push(this.opts.turnInHint);
    }
    return { title: resolved.name, lines };
  }

  /** Resolve which quest to display: the pinned quest (setQuest) if it exists, else the
   *  entity's tracked active quest, else its first active quest. Returns undefined when
   *  no quest manager is wired or the entity has nothing to show. */
  private resolveQuest(entity: string): ResolvedQuest | undefined {
    const quest = this.managers.quest;
    if (quest === undefined) return undefined;

    let instance: QuestInstance | undefined;
    if (this.trackedQuestId !== undefined) {
      instance = quest.getInstance(entity, this.trackedQuestId);
    }
    if (instance === undefined) {
      const active = quest.list(entity, "active");
      instance = active.find((q) => q.tracked) ?? active[0];
    }
    if (instance === undefined) return undefined;

    const def = quest.getDefinition(instance.questId);
    const name = def?.name ?? instance.questId;
    const objectives = instance.objectives.map((o) => {
      const defObj = def?.objectives.find((d) => d.id === o.id);
      return {
        desc: defObj?.description ?? o.id,
        progress: o.progress,
        required: defObj?.required ?? 0,
      };
    });
    return { name, objectives };
  }
}
