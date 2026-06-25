// SandboxedProvider — slots an UNTRUSTED QuickJS-sandboxed agent into the LIVE
// agent decision pipeline behind the existing LLMProvider seam. Where a
// ScriptedProvider/OllamaProvider returns candidate tool calls from trusted
// in-process logic, this runs the agent's decision code in its QuickJS sandbox
// (off the privileged isolate) and returns the capability calls it recorded.
//
// The decisionSystem then validates those calls against skill schemas and the
// actionSystem drives them through SkillRegistry.invoke under HOST-BOUND
// attribution (agent.id / agent.sessionId / resolveProfile(agent.profile)) — the
// untrusted code never touches the registry, and a contained decision
// (interrupt/OOM/crash) simply yields zero actions.

import type { LLMProvider, DecideRequest } from "../agents/llm.ts";
import type { MCPRequest } from "../mcp/protocol.ts";
import { parseUntrustedArgs, type SandboxedSkillHost } from "./host.ts";

export class SandboxedProvider implements LLMProvider {
  readonly name = "sandboxed";

  constructor(private readonly host: SandboxedSkillHost) {}

  decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[] }> {
    const agentId = req.perception.selfId;
    const ev = this.host.produceCalls(agentId, req.perception);
    if (!ev.ok) return Promise.resolve({ toolCalls: [] });
    const toolCalls: MCPRequest[] = ev.calls.map((call) => ({ tool: call.cap, input: parseUntrustedArgs(call.args).input }));
    return Promise.resolve({ toolCalls });
  }
}
