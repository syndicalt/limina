// Dialogue → UI bridge — a RENDER-ORCHESTRATION helper (NOT a new skill). A sibling
// of character_model.ts / locomotion.ts: same world/ helper style, same split between
// the RECORDED sim surface and a RENDER-ONLY presentation the host drives.
//
//   new DialogueRuntime({ registry, base, uiManager, world })
//     .open(speaker, listener, treeId)  -> show the start node's line + choices
//     .choose(index)                    -> advance the tree + re-render
//     .advance()                        -> end a terminal node + tear the UI down
//
// STATE vs RENDER (the whole point of this helper):
//   • STATE is driven through the EXISTING, RECORDED `dialogue.*` skills via the
//     registry — `dialogue.start` / `dialogue.choose` / `dialogue.end`. Those are the
//     ONLY actions this helper records into the world log, so a record→replay run
//     recomputes BIT-IDENTICAL DialogueManager state (the sim surface is exactly the
//     three dialogue mutations, nothing else).
//   • RENDER is driven by calling the UiManager DIRECTLY (uiManager.create / update /
//     remove) — never through the `ui.*` skills — so speech bubbles and the choices
//     panel NEVER bloat the log. UI is purely cosmetic: sim/replay are unaffected.
//
// The current node + available choices are read straight off the dialogue.start /
// dialogue.choose RETURN VALUES (each returns the resolved NodeView: id, text, and
// choice texts). This deliberately avoids `dialogue.get`, which — being a top-level
// registry invoke — WOULD be recorded; keeping the recorded surface to exactly the
// three mutations is what makes replay-equivalence provable.
//
// DETERMINISM: no Date.now / Math.random; the only recorded actions are the dialogue
// mutations (which themselves stamp nothing wall-clock). INPUT-SOURCE-AGNOSTIC: the
// host passes a chosen choice INDEX to choose(i) (a demo maps number keys 1..N → i;
// a test passes indices directly). This helper never reads op_input — it stays
// decoupled from the input op surface.

import { Position } from "../ecs/world.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { UiManager } from "../ui/manager.ts";
import type { Vec3 } from "../ui/anchor.ts";

/** The resolved node view the dialogue.* skills hand back (id + text + choice texts). */
interface NodeView {
  id: string;
  text: string;
  choices: { text: string }[];
}

/** dialogue.start output. */
interface StartResult {
  ok: boolean;
  currentNode?: NodeView;
}

/** dialogue.choose output. */
interface ChooseResult {
  ok: boolean;
  node?: NodeView;
}

/** Presentation knobs (all render-only; never affect sim/replay). */
export interface DialogueRuntimeOptions {
  /** World offset for the speaker's speech bubble (above the head). Default [0, 2.0, 0]. */
  speakerOffset?: Vec3;
  /** Screen corner for the choices panel. Default "bottom-center". */
  choicesCorner?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center" | "center";
  /** Choices panel pixel margin from its corner. Default [24, 24]. */
  choicesMarginPx?: [number, number];
  /** Choices panel fixed width (px). Default 540. */
  choicesWidth?: number;
  /** Choices panel header. Default "CHOICES". */
  choicesTitle?: string;
  /** Line shown in the choices panel when the current node is terminal (no choices).
   *  Default "[ continue ]". */
  continuePrompt?: string;
  /** Speech bubble max width (px). Default 280. */
  bubbleMaxWidth?: number;
}

const DEFAULT_SPEAKER_OFFSET: Vec3 = [0, 2.0, 0];
const DEFAULT_CHOICES_MARGIN: [number, number] = [24, 24];

export interface DialogueRuntimeDeps {
  registry: SkillRegistry;
  /** The caller's invoke base (agent/session/permissions/tick/world). Used for every
   *  recorded dialogue.* invoke. */
  base: InvokeBase;
  /** The shared UiManager (core.ui) the host ticks each frame. */
  uiManager: UiManager;
  /** The world context (entity table for anchor resolution + the scene to add panels to). */
  world: WorldContext;
  options?: DialogueRuntimeOptions;
}

/**
 * Drives an active dialogue onto the screen: the speaker's line as a world-anchored
 * speech bubble, the available choices as a screen-anchored, numbered HUD panel. The
 * host advances it by feeding a chosen choice INDEX into choose(i); state lives in the
 * recorded dialogue.* skills, presentation lives in the UiManager — see the file header.
 */
export class DialogueRuntime {
  private readonly registry: SkillRegistry;
  private readonly base: InvokeBase;
  private readonly uiManager: UiManager;
  private readonly world: WorldContext;
  private readonly opts: Required<DialogueRuntimeOptions>;

  private active = false;
  private speaker: string | undefined;
  private listener: string | undefined;
  private speakerEid: number | undefined;
  private node: NodeView | undefined;
  private speechHandle: string | undefined;
  private choicesHandle: string | undefined;

  constructor(deps: DialogueRuntimeDeps) {
    this.registry = deps.registry;
    this.base = deps.base;
    this.uiManager = deps.uiManager;
    this.world = deps.world;
    const o = deps.options ?? {};
    this.opts = {
      speakerOffset: o.speakerOffset ?? DEFAULT_SPEAKER_OFFSET,
      choicesCorner: o.choicesCorner ?? "bottom-center",
      choicesMarginPx: o.choicesMarginPx ?? DEFAULT_CHOICES_MARGIN,
      choicesWidth: o.choicesWidth ?? 540,
      choicesTitle: o.choicesTitle ?? "CHOICES",
      continuePrompt: o.continuePrompt ?? "[ continue ]",
      bubbleMaxWidth: o.bubbleMaxWidth ?? 280,
    };
  }

  // -- public host/test surface ------------------------------------------------

  /** Whether a dialogue is currently open + rendered. */
  isActive(): boolean {
    return this.active;
  }

  /** The current node's body text (empty string when inactive). */
  currentText(): string {
    return this.node?.text ?? "";
  }

  /** The current node's available choice texts (empty when inactive/terminal). */
  currentChoices(): string[] {
    return this.node !== undefined ? this.node.choices.map((c) => c.text) : [];
  }

  /** Whether the current node is terminal (no choices) — the host should advance(). */
  isTerminal(): boolean {
    return this.active && this.node !== undefined && this.node.choices.length === 0;
  }

  /** The exact numbered lines rendered into the choices panel (for the host/tests). */
  choiceLines(): string[] {
    return this.computeChoiceLines();
  }

  /** The live speech-bubble handle (undefined when inactive). */
  get speechBubbleHandle(): string | undefined {
    return this.speechHandle;
  }

  /** The live choices-panel handle (undefined when inactive). */
  get choicesPanelHandle(): string | undefined {
    return this.choicesHandle;
  }

  /**
   * Open a dialogue: start the session (RECORDED via dialogue.start), then render the
   * start node's line on the speaker + the choices on screen. A second open() while one
   * is active closes the prior first. Throws (fail loud at author time) when the speaker
   * is not a known entity or the tree/start node cannot be resolved.
   */
  async open(speaker: string, listener: string, treeId: string): Promise<void> {
    if (this.active) this.close();

    // Validate the speaker is a real entity BEFORE starting a session, so the bubble
    // has something to anchor to and we never leave an orphan session behind.
    const eid = this.world.entities.resolve(speaker)?.eid;
    if (eid === undefined) {
      throw new Error(`DialogueRuntime.open: unknown speaker entity '${speaker}'`);
    }

    const res = await this.invoke<StartResult>("dialogue.start", { treeId, speaker, listener });
    if (!res.ok || res.currentNode === undefined) {
      throw new Error(`DialogueRuntime.open: dialogue.start could not resolve tree '${treeId}' for ${speaker}→${listener}`);
    }

    this.speaker = speaker;
    this.listener = listener;
    this.speakerEid = eid;
    this.node = res.currentNode;
    this.active = true;
    this.renderFresh();
  }

  /**
   * Pick choice `index` (input-source-agnostic — the host maps its own input to an index).
   * A valid index advances the tree (RECORDED via dialogue.choose) and re-renders the new
   * node (or, on a terminal node, the line + a continue prompt). An out-of-range index is
   * ignored cleanly (no throw, no advance). Returns whether the dialogue advanced.
   */
  async choose(index: number): Promise<boolean> {
    if (!this.active || this.node === undefined || this.speaker === undefined || this.listener === undefined) {
      return false;
    }
    // Out-of-range (incl. a terminal node, which has zero choices) → ignored.
    if (!Number.isInteger(index) || index < 0 || index >= this.node.choices.length) {
      return false;
    }
    const res = await this.invoke<ChooseResult>("dialogue.choose", {
      speaker: this.speaker,
      listener: this.listener,
      choiceIndex: index,
    });
    if (!res.ok || res.node === undefined) return false;
    this.node = res.node;
    this.renderUpdate();
    return true;
  }

  /**
   * On a TERMINAL node (no choices), end the session (RECORDED via dialogue.end) and tear
   * the UI down. A no-op when inactive or when the current node still has choices (the host
   * should choose() first).
   */
  async advance(): Promise<boolean> {
    if (!this.active || this.node === undefined || this.speaker === undefined || this.listener === undefined) {
      return false;
    }
    if (this.node.choices.length > 0) return false;
    await this.invoke<{ ok: boolean }>("dialogue.end", { speaker: this.speaker, listener: this.listener });
    this.close();
    return true;
  }

  /** Remove every dialogue UI panel and reset to inactive. Idempotent (safe to call
   *  when nothing is open). Render-only: never touches the recorded session. */
  close(): void {
    if (this.speechHandle !== undefined) {
      this.uiManager.remove(this.speechHandle);
      this.speechHandle = undefined;
    }
    if (this.choicesHandle !== undefined) {
      this.uiManager.remove(this.choicesHandle);
      this.choicesHandle = undefined;
    }
    this.active = false;
    this.node = undefined;
    this.speaker = undefined;
    this.listener = undefined;
    this.speakerEid = undefined;
  }

  // -- internals ---------------------------------------------------------------

  private async invoke<T>(tool: string, input: Record<string, unknown>): Promise<T> {
    const res = await this.registry.invoke(tool, input, this.base);
    if (!res.success) {
      throw new Error(`DialogueRuntime: ${tool} failed: ${JSON.stringify(res.error)}`);
    }
    return res.result as T;
  }

  /** Numbered choice lines ("1) …", "2) …"), or the continue prompt on a terminal node. */
  private computeChoiceLines(): string[] {
    if (this.node === undefined) return [];
    if (this.node.choices.length === 0) return [this.opts.continuePrompt];
    return this.node.choices.map((c, i) => `${i + 1}) ${c.text}`);
  }

  /** Build both panels for a freshly-opened node. */
  private renderFresh(): void {
    if (this.node === undefined || this.speakerEid === undefined) return;
    const eid = this.speakerEid;
    const speech = this.uiManager.create(this.world.scene, "speechBubble", {
      anchor: {
        kind: "world",
        // Live SoA getter so the bubble follows the speaker (mirrors ui.* resolveAnchor).
        position: (): Vec3 => [Position.x[eid], Position.y[eid], Position.z[eid]],
        offset: this.opts.speakerOffset,
        billboard: true,
        renderOrder: 20,
        depthTest: false,
      },
      text: this.node.text,
      maxWidth: this.opts.bubbleMaxWidth,
    });
    this.speechHandle = speech.handle;

    const choices = this.uiManager.create(this.world.scene, "hudPanel", {
      anchor: {
        kind: "screen",
        corner: this.opts.choicesCorner,
        marginPx: this.opts.choicesMarginPx,
      },
      title: this.opts.choicesTitle,
      lines: this.computeChoiceLines(),
      width: this.opts.choicesWidth,
    });
    this.choicesHandle = choices.handle;
  }

  /** Patch both live panels to the current node (after an advance). */
  private renderUpdate(): void {
    if (this.node === undefined) return;
    if (this.speechHandle !== undefined) {
      this.uiManager.update(this.speechHandle, { text: this.node.text });
    }
    if (this.choicesHandle !== undefined) {
      this.uiManager.update(this.choicesHandle, { lines: this.computeChoiceLines() });
    }
  }
}
