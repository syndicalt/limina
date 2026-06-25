// social.* skills — the agent-native surface for embodied social action. Both
// are Zod-validated, permission-checked (`social.act`), and traced; the SPEAKER
// identity is always HOST-BOUND to ctx.agentId (never a payload field), so no
// agent can author an utterance as another.
//
//   social.approach({ target })  -> set the calling agent's locomotion move
//       target (an agent/entity id or a world point); emits social.approached.
//       The locomotion system walks them there over subsequent fixed steps.
//   social.say({ text })         -> emit social.said (actorId = ctx.agentId) AND
//       drive a REAL speech bubble through the shared UiManager, anchored above
//       the speaking agent's humanoid, with a per-speaker queue (successive lines
//       hold then advance). Not a logged string: a live container in the scene.
//
// Registration is wired in registerCoreSkills alongside the ui.* skills: the
// skills receive the shared UiManager + the Locomotion (which is also the
// host-bound speaker -> entity resolver).

import { z } from "../../build/zod.bundle.mjs";
import { Position } from "../ecs/world.ts";
import type { TextStyle } from "../ui/compositor.ts";
import type { UiCreateOptions, UiManager } from "../ui/manager.ts";
import type { Locomotion, MoveTarget, Vec3 } from "../world/locomotion.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

/** Runtime dependencies the social skills act through (host-owned, shared). */
export interface SocialDeps {
  ui: UiManager;
  locomotion: Locomotion;
  /** Host-bound speaker -> entity resolver. NEVER derived from a payload. */
  resolveEntity(agentId: string): string | undefined;
}

/** Inspection surface a host/test uses to find an agent's live speech bubble. */
export interface SocialRuntime {
  /** The live per-speaker speech-bubble handle, if the agent has spoken. */
  bubbleHandle(agentId: string): string | undefined;
  /** Fade out + remove an agent's live speech bubble (call when its
   *  conversation ends). Returns false when the agent has no live bubble. */
  dismiss(agentId: string): boolean;
  /** Whether the agent's live speech bubble has FULLY revealed its current line
   *  (true when it has no bubble, so a caller gating on it never blocks). Lets a
   *  director hold a turn until the typewriter finishes the line. */
  revealed(agentId: string): boolean;
}

const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const approachInput = z.object({
  /** An agent id, an `ent_` entity id, or a world point to approach. */
  target: z.union([z.string().min(1), vec3Schema]),
  /** Optional stop distance override for this approach. */
  talkDistance: z.number().positive().max(50).optional(),
}).strict();

const sayInput = z.object({
  text: z.string().min(1).max(280),
  /** Accepted for provider ergonomics but IGNORED: the speaker is host-bound to
   *  ctx.agentId, so a payload id can never spoof another agent. */
  actorId: z.string().optional(),
}).strict();

const approachOutput = z.object({
  approaching: z.boolean(),
  target: z.union([z.string(), vec3Schema]),
});
const sayOutput = z.object({ said: z.boolean(), speaker: z.string(), handle: z.string() });

/** Bubble chrome: a rounded dark panel whose tail points DOWN at the speaker.
 *  Wide + small leading keeps a long LLM line readable. The bubble AUTO-SIZES to
 *  its full wrapped height (no line cap) so the whole statement is shown; the
 *  UiManager layout pass keeps it fully on-screen — a content-tall bubble is
 *  clamped (slid down, never top-clipped), not truncated. */
const BUBBLE_STYLE: TextStyle = {
  background: { color: 0x161c28, opacity: 0.94 },
  border: { width: 2, color: 0x46506a, radius: 12 },
  text: { color: 0xf3f5f7, scale: 2, align: "left", lineHeight: 32 },
  padding: { top: 9, right: 13, bottom: 9, left: 13 },
};

export function registerSocialSkills(registry: SkillRegistry, deps: SocialDeps): SocialRuntime {
  // Per-speaker live bubble handle (one bubble per agent; replace/queue lines).
  const bubbles = new Map<string, string>();

  const approach: SkillDefinition<z.infer<typeof approachInput>, z.infer<typeof approachOutput>> = {
    name: "social.approach",
    version: "1.0.0",
    description: "Walk the calling agent toward a target (an agent id, an entity id, or a world point). Sets the move target the locomotion system pursues; emits social.approached.",
    category: "social",
    permissions: ["social.act"],
    input: approachInput,
    output: approachOutput,
    handler: (input, ctx) => {
      const selfEntity = deps.resolveEntity(ctx.agentId);
      if (selfEntity === undefined || !deps.locomotion.has(ctx.agentId)) {
        throw new Error(`social.approach: ${ctx.agentId} is not an embodied locomotion actor`);
      }
      let target: MoveTarget;
      if (typeof input.target === "string") {
        // An agent id resolves to its bound entity; otherwise treat it as a
        // direct entity id. Either way it must resolve to a real world entity.
        const entity = deps.resolveEntity(input.target) ?? input.target;
        if (ctx.world.entities.resolve(entity) === undefined) {
          throw new Error(`social.approach: unknown target '${input.target}'`);
        }
        target = { kind: "entity", entity };
      } else {
        target = { kind: "point", point: input.target as Vec3 };
      }
      deps.locomotion.setTarget(ctx.agentId, target, input.talkDistance);
      const targetRef = target.kind === "entity" ? target.entity : target.point;
      ctx.emit("social.approached", { actorId: ctx.agentId, entity: selfEntity, target: targetRef, kind: target.kind });
      return { approaching: true, target: targetRef };
    },
  };

  const say: SkillDefinition<z.infer<typeof sayInput>, z.infer<typeof sayOutput>> = {
    name: "social.say",
    version: "1.0.0",
    description: "Speak a line as the calling agent: emits social.said (actorId = the host-bound caller) and shows a real speech bubble anchored above the speaker's humanoid (per-speaker queue).",
    category: "social",
    permissions: ["social.act"],
    input: sayInput,
    output: sayOutput,
    handler: (input, ctx) => {
      // HOST-BOUND speaker: ctx.agentId only. A payload `actorId` is ignored.
      const speaker = ctx.agentId;
      const entityId = deps.resolveEntity(speaker);
      if (entityId === undefined) throw new Error(`social.say: no humanoid bound to ${speaker}`);
      const entry = ctx.world.entities.resolve(entityId);
      if (entry === undefined) throw new Error(`social.say: entity ${entityId} not in world`);
      const eid = entry.eid;

      ctx.emit("social.said", { actorId: speaker, entity: entityId, text: input.text });

      // REAL speech bubble: reuse the speaker's live bubble (queue the new line)
      // or author a fresh one anchored to follow the speaker's SoA position.
      const existing = bubbles.get(speaker);
      if (existing !== undefined && deps.ui.has(existing)) {
        deps.ui.update(existing, { text: input.text });
      } else {
        const headY = deps.locomotion.heightOf(speaker) ?? 1.75;
        const opts: UiCreateOptions = {
          anchor: {
            kind: "world",
            position: () => [Position.x[eid], Position.y[eid], Position.z[eid]] as Vec3,
            // Above the head to start; when two speakers' bubbles would overlap,
            // the UiManager side-placement pass slides each to its OUTER side and
            // re-aims the tail. The nametag sits below this and never collides.
            offset: [0, headY + 1.45, 0],
            billboard: true,
            // The bubble is the important content: draw it OVER the nametag
            // (higher order) and ignore depth so a closer label/tree can't hide
            // it. The nametag label keeps the default order (0) + depthTest.
            renderOrder: 20,
            depthTest: false,
          },
          style: BUBBLE_STYLE,
          text: input.text,
          // Wider box -> a 1-2 sentence line wraps to a few WIDE lines (fewer,
          // shorter columns); the 4-line cap + reveal keep it on screen.
          maxWidth: 380,
          pixelScale: 0.009,
          // Tail points straight down by default; the side-placement pass re-aims
          // it along the bottom edge to keep pointing at the speaker after a slide.
          tail: { toward: { x: 0, y: -1 } },
          lifecycle: {
            // Type the line in (the "typeahead chat"); a long line scroll-reveals
            // within the capped height instead of growing an off-screen column.
            queue: { mode: "queue", lines: [input.text], defaultHoldMs: 2600, cps: 42 },
            fade: { from: 0, to: 1, durationMs: 220 },
          },
        };
        const { handle } = deps.ui.create(ctx.world.scene, "speechBubble", opts);
        bubbles.set(speaker, handle);
      }
      return { said: true, speaker, handle: bubbles.get(speaker) as string };
    },
  };

  registry.register(approach);
  registry.register(say);

  return {
    bubbleHandle: (agentId) => bubbles.get(agentId),
    dismiss: (agentId) => {
      const handle = bubbles.get(agentId);
      if (handle === undefined) return false;
      bubbles.delete(agentId); // a later say() authors a fresh bubble
      return deps.ui.has(handle) ? deps.ui.dismiss(handle) : false;
    },
    revealed: (agentId) => {
      const handle = bubbles.get(agentId);
      if (handle === undefined) return true; // no bubble yet -> nothing to wait on
      return deps.ui.has(handle) ? deps.ui.revealed(handle) : true;
    },
  };
}
