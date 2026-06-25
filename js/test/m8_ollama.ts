// M8 — LLM seam live smoke: OllamaProvider drives a real local model to emit a
// schema-valid tool call; malformed/garbage responses are rejected by parsing.

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { OllamaProvider, parseOllamaToolCalls } from "../src/agents/llm.ts";
import type { Perception } from "../src/agents/agent.ts";

// Parsing rejects garbage + malformed tool calls (no network).
if (parseOllamaToolCalls("not json").length !== 0) throw new Error("garbage not rejected");
if (parseOllamaToolCalls(JSON.stringify({ message: { tool_calls: [{ function: { name: 123 } }] } })).length !== 0) {
  throw new Error("malformed tool call (non-string name) not rejected");
}
if (parseOllamaToolCalls(JSON.stringify({ message: { content: "hi" } })).length !== 0) {
  throw new Error("no-tool-call response should yield []");
}

const registry = new SkillRegistry(new LiminaTracer("ses_m8"));
registerCoreSkills(registry);
const tools = registry.list();

const provider = new OllamaProvider("qwen2.5-coder:3b");
const perception: Perception = { selfId: "agt_builder", nearby: [], recentEvents: [], tick: 0 };
const systemPrompt =
  "You are a 3D scene builder with tools. Create one red box (color 16711680) at position [0,1,0] by calling the box-creation tool. You MUST call a tool.";
ops.op_log("M8: calling Ollama qwen2.5-coder:3b (may take a few seconds)...");
const { toolCalls } = await provider.decide({ systemPrompt, perception, tools, previousResults: [] });
ops.op_log(`M8: ollama returned ${toolCalls.length} tool call(s): ${toolCalls.map((c) => c.tool).join(", ")}`);

if (toolCalls.length === 0) throw new Error("Ollama returned no tool calls (model availability / prompt issue)");

let validCount = 0;
for (const call of toolCalls) {
  const skill = registry.describe(call.tool);
  if (skill !== undefined && skill.input.safeParse(call.input).success) validCount += 1;
}
if (validCount === 0) throw new Error("no schema-valid tool calls: " + JSON.stringify(toolCalls));

ops.op_log(`M8 OK: OllamaProvider produced ${validCount} schema-valid tool call(s); malformed/garbage rejected`);
