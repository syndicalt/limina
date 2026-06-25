// agent.* skills — inter-agent/system signalling. agent.getPerception is added
// in M7 once AgentRecord/Perception exist.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const emitEventInput = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const emitEvent: SkillDefinition<z.infer<typeof emitEventInput>, { eventId: string }> = {
  name: "agent.emitEvent",
  version: "1.0.0",
  description: "Emit a custom event into the observability trace (inter-agent or system signal).",
  category: "agent",
  permissions: ["agent.write"],
  input: emitEventInput,
  output: z.object({ eventId: z.string() }),
  handler: (input, ctx) => {
    const eventId = ctx.emit(`agent.signal.${input.type}`, input.payload);
    return { eventId };
  },
};

const getPerceptionInput = z.object({});
const getPerception: SkillDefinition<z.infer<typeof getPerceptionInput>, { perception: unknown }> = {
  name: "agent.getPerception",
  version: "1.0.0",
  description: "Get the calling agent's current perception (nearby entities + recent events).",
  category: "agent",
  permissions: ["agent.read"],
  input: getPerceptionInput,
  output: z.object({ perception: z.unknown() }),
  handler: (_input, ctx) => ({ perception: ctx.world.agents?.getPerception(ctx.agentId) ?? null }),
};

export function registerAgentSkills(registry: SkillRegistry): void {
  registry.register(emitEvent);
  registry.register(getPerception);
}
