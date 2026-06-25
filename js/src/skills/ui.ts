// ui.* skills — the agent-native surface over the A2/A3 container layer. A
// builder over MCP authors expressive containers (speech/thought bubbles, text
// boxes, labels, callouts, HUD panels) exactly as it authors the world: every
// call is Zod-validated, permission-checked (`ui.write`), and traced
// (registry `skill.executed` + a `ui.*` event). The skills only register /
// update / remove against the UiManager (../ui/manager.ts) — the per-frame
// anchor + lifecycle tick is the host's job (UiManager.update(camera,…)).

import { z } from "../../build/zod.bundle.mjs";
import { Position } from "../ecs/world.ts";
import type { TextStyle } from "../ui/compositor.ts";
import type { Vec3 } from "../ui/anchor.ts";
import {
  type UiAnchorSpec,
  type UiCreateOptions,
  type UiKind,
  type UiManager,
} from "../ui/manager.ts";
import type { ExecutionContext, SkillDefinition, SkillRegistry } from "./registry.ts";

// ---- style schema: a Zod mirror of the compositor TextStyle ----------------

/** A color: a packed 0xRRGGBB int (opaque) or an explicit straight-alpha RGBA. */
const colorSchema = z.union([
  z.number().int().min(0).max(0xffffff),
  z.object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
    a: z.number().int().min(0).max(255),
  }).strict(),
]);

const alignEnum = z.enum(["left", "center", "right"]);
const insetsSchema = z.object({
  top: z.number().min(0),
  right: z.number().min(0),
  bottom: z.number().min(0),
  left: z.number().min(0),
}).strict();
const paddingSchema = z.union([z.number().min(0), insetsSchema]);

const backgroundSchema = z.object({ color: colorSchema, opacity: z.number().min(0).max(1).optional() }).strict();
const borderSchema = z.object({ width: z.number().min(0), color: colorSchema, radius: z.number().min(0).optional() }).strict();
const titleSchema = z.object({
  color: colorSchema.optional(),
  background: colorSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  height: z.number().min(0).optional(),
  align: alignEnum.optional(),
  scale: z.number().int().min(1).optional(),
}).strict();
const textSchema = z.object({
  color: colorSchema.optional(),
  scale: z.number().int().min(1).optional(),
  align: alignEnum.optional(),
  lineHeight: z.number().positive().optional(),
  letterSpacing: z.number().min(0).optional(),
}).strict();
const shadowSchema = z.object({
  color: colorSchema.optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  blur: z.number().min(0).optional(),
  opacity: z.number().min(0).max(1).optional(),
}).strict();
const gradientSchema = z.object({
  from: colorSchema,
  to: colorSchema,
  direction: z.enum(["vertical", "horizontal"]).optional(),
  opacity: z.number().min(0).max(1).optional(),
}).strict();
const textRunSchema = z.object({ text: z.string(), color: colorSchema.optional(), scale: z.number().int().min(1).optional() }).strict();

/** The validated style object — mirrors TextStyle's expressive surface. Strict:
 *  unknown keys, bad colors, and non-positive sizes are REJECTED (no panel). */
export const uiStyleSchema = z.object({
  background: backgroundSchema.optional(),
  border: borderSchema.optional(),
  title: titleSchema.optional(),
  text: textSchema.optional(),
  padding: paddingSchema.optional(),
  maxWidth: z.number().positive().optional(),
  width: z.number().positive().optional(),
  minWidth: z.number().positive().optional(),
  height: z.number().positive().optional(),
  maxLines: z.number().int().positive().optional(),
  noWrap: z.boolean().optional(),
  shadow: shadowSchema.optional(),
  gradient: gradientSchema.optional(),
  runs: z.array(textRunSchema).optional(),
}).strict();

// ---- anchor / tail / lifecycle schemas -------------------------------------

const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const sideEnum = z.enum(["top", "bottom", "left", "right"]);

const worldAnchorSchema = z.object({
  kind: z.literal("world"),
  /** follow an entity (its live SoA position) … */
  entity: z.string().optional(),
  /** … or pin to a fixed world point. */
  point: vec3Schema.optional(),
  offset: vec3Schema.optional(),
  billboard: z.boolean().optional(),
  renderOrder: z.number().optional(),
  depthTest: z.boolean().optional(),
}).strict();
const screenAnchorSchema = z.object({
  kind: z.literal("screen"),
  corner: z.enum([
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "top-center",
    "bottom-center",
    "center",
  ]).optional(),
  marginPx: z.tuple([z.number(), z.number()]).optional(),
  distance: z.number().positive().optional(),
  renderOrder: z.number().optional(),
}).strict();
const anchorSchema = z.discriminatedUnion("kind", [worldAnchorSchema, screenAnchorSchema]);

const towardSchema = z.object({ x: z.number(), y: z.number() }).strict();
const tailSchema = z.object({
  toward: towardSchema.optional(),
  side: sideEnum.optional(),
  count: z.number().int().min(1).max(8).optional(),
  length: z.number().positive().optional(),
  base: z.number().positive().optional(),
}).strict();
const leaderSchema = z.object({
  dx: z.number(),
  dy: z.number(),
  side: sideEnum.optional(),
  offset: z.number().min(0).max(1).optional(),
  width: z.number().positive().optional(),
  color: colorSchema.optional(),
  dot: z.number().min(0).optional(),
}).strict();
const lifecycleSchema = z.object({
  fade: z.object({
    from: z.number().min(0).max(1).optional(),
    to: z.number().min(0).max(1).optional(),
    durationMs: z.number().positive(),
  }).strict().optional(),
  typewriter: z.object({ cps: z.number().positive() }).strict().optional(),
  ttl: z.number().positive().optional(),
  queue: z.object({
    mode: z.enum(["queue", "replace"]).optional(),
    defaultHoldMs: z.number().positive().optional(),
    lines: z.array(z.string()).optional(),
  }).strict().optional(),
  feed: z.object({ maxLines: z.number().int().min(1).max(64) }).strict().optional(),
}).strict();

const kindEnum = z.enum(["label", "textBox", "speechBubble", "thoughtBubble", "callout", "hudPanel"]);

/** Shared create fields for every kind (ui.panel adds `kind`). */
const createShape = {
  anchor: anchorSchema,
  style: uiStyleSchema.optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  lines: z.array(z.string()).optional(),
  maxWidth: z.number().positive().optional(),
  width: z.number().positive().optional(),
  maxLines: z.number().int().positive().optional(),
  pixelScale: z.number().positive().optional(),
  tail: tailSchema.optional(),
  leader: leaderSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
};

const panelInput = z.object({ kind: kindEnum, ...createShape }).strict();
const kindInput = z.object(createShape).strict();
type CreateInput = z.infer<typeof panelInput> | (z.infer<typeof kindInput> & { kind?: undefined });

const updateInput = z.object({
  handle: z.string(),
  text: z.string().optional(),
  title: z.string().optional(),
  style: uiStyleSchema.optional(),
  lines: z.array(z.string()).optional(),
}).strict();
const removeInput = z.object({ handle: z.string() }).strict();

const handleOutput = z.object({ handle: z.string() });
const updateOutput = z.object({ ok: z.boolean(), changed: z.boolean() });
const removeOutput = z.object({ removed: z.boolean() });

// ---- handlers --------------------------------------------------------------

/** Turn a validated anchor into a UiManager anchor spec. A world anchor that
 *  names an entity follows its live SoA position; an unknown entity is a hard
 *  (zero-effect) error before any panel is built. */
function resolveAnchor(anchor: z.infer<typeof anchorSchema>, ctx: ExecutionContext): UiAnchorSpec {
  if (anchor.kind === "screen") {
    return {
      kind: "screen",
      corner: anchor.corner,
      marginPx: anchor.marginPx,
      distance: anchor.distance,
      renderOrder: anchor.renderOrder,
    };
  }
  if (anchor.entity !== undefined) {
    const eid = ctx.world.entities.resolve(anchor.entity)?.eid;
    if (eid === undefined) throw new Error(`ui anchor: unknown entity ${anchor.entity}`);
    return {
      kind: "world",
      position: () => [Position.x[eid], Position.y[eid], Position.z[eid]] as Vec3,
      offset: anchor.offset,
      billboard: anchor.billboard,
      renderOrder: anchor.renderOrder,
      depthTest: anchor.depthTest,
    };
  }
  const point: Vec3 = anchor.point ?? [0, 0, 0];
  return { kind: "world", position: point, offset: anchor.offset, billboard: anchor.billboard, renderOrder: anchor.renderOrder, depthTest: anchor.depthTest };
}

function toCreateOptions(input: CreateInput, ctx: ExecutionContext): UiCreateOptions {
  return {
    anchor: resolveAnchor(input.anchor, ctx),
    style: input.style as TextStyle | undefined,
    text: input.text,
    title: input.title,
    lines: input.lines,
    maxWidth: input.maxWidth,
    width: input.width,
    maxLines: input.maxLines,
    pixelScale: input.pixelScale,
    tail: input.tail,
    leader: input.leader,
    lifecycle: input.lifecycle,
  };
}

/** Build a create skill for a fixed kind (per-kind skills) or `undefined` (the
 *  unified ui.panel, which reads `kind` from input). */
function makeCreateSkill(
  manager: UiManager,
  name: string,
  description: string,
  fixedKind: UiKind | undefined,
): SkillDefinition<CreateInput, { handle: string }> {
  return {
    name,
    version: "1.0.0",
    description,
    category: "ui",
    permissions: ["ui.write"],
    input: (fixedKind === undefined ? panelInput : kindInput) as z.ZodType<CreateInput>,
    output: handleOutput,
    handler: (input, ctx) => {
      const kind: UiKind = fixedKind ?? (input.kind as UiKind);
      const { handle } = manager.create(ctx.world.scene, kind, toCreateOptions(input, ctx));
      ctx.emit("ui.panel.created", { handle, kind, anchor: input.anchor.kind });
      return { handle };
    },
  };
}

export function registerUiSkills(registry: SkillRegistry, manager: UiManager): void {
  registry.register(makeCreateSkill(
    manager,
    "ui.panel",
    "Author a styled UI container (kind = label/textBox/speechBubble/thoughtBubble/callout/hudPanel) with a full Zod style object, world/screen anchor, optional tail/leader and lifecycle (fade/typewriter/ttl/queue/feed). Returns an opaque handle.",
    undefined,
  ));
  registry.register(makeCreateSkill(manager, "ui.label", "Place a billboard label (minimal chrome) tracking an entity or world point.", "label"));
  registry.register(makeCreateSkill(manager, "ui.textBox", "Place a titled text box (header bar + wrapped body) at a world or screen anchor.", "textBox"));
  registry.register(makeCreateSkill(manager, "ui.speechBubble", "Place a speech bubble with a directional tail aimed at the speaker (entity/point).", "speechBubble"));
  registry.register(makeCreateSkill(manager, "ui.thoughtBubble", "Place a thought bubble with trailing puffs leading back to the thinker.", "thoughtBubble"));
  registry.register(makeCreateSkill(manager, "ui.callout", "Place an annotation box with a leader line to a target point.", "callout"));
  registry.register(makeCreateSkill(manager, "ui.hudPanel", "Place a screen-anchored HUD/overlay panel (corner-pinned, DPI-aware, over the scene).", "hudPanel"));

  const update: SkillDefinition<z.infer<typeof updateInput>, z.infer<typeof updateOutput>> = {
    name: "ui.update",
    version: "1.0.0",
    description: "Update a live container by handle: change its text, title, body lines, and/or restyle it (re-composites). Returns whether the handle existed and re-composited.",
    category: "ui",
    permissions: ["ui.write"],
    input: updateInput,
    output: updateOutput,
    handler: (input, ctx) => {
      const ok = manager.has(input.handle);
      const changed = manager.update(input.handle, {
        text: input.text,
        title: input.title,
        style: input.style as TextStyle | undefined,
        lines: input.lines,
      });
      ctx.emit("ui.panel.updated", { handle: input.handle, ok, changed });
      return { ok, changed };
    },
  };
  registry.register(update);

  const remove: SkillDefinition<z.infer<typeof removeInput>, z.infer<typeof removeOutput>> = {
    name: "ui.remove",
    version: "1.0.0",
    description: "Remove a live container by handle: detach its mesh from the scene and dispose its GPU resources.",
    category: "ui",
    permissions: ["ui.write"],
    input: removeInput,
    output: removeOutput,
    handler: (input, ctx) => {
      const removed = manager.remove(input.handle);
      ctx.emit("ui.panel.removed", { handle: input.handle, removed });
      return { removed };
    },
  };
  registry.register(remove);
}
