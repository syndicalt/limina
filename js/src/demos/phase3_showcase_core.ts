// Shared Phase 3 showcase behavior. The windowed demo uses this module, and
// the headless test verifies the Phase 3-specific scheduling/provider semantics.

import { ops } from "../engine.ts";
import type { AgentRegistry } from "../agents/agent.ts";
import { AgentScheduler } from "../agents/scheduler.ts";
import type { DecideRequest, LLMProvider } from "../agents/llm.ts";
import type { MCPRequest } from "../mcp/protocol.ts";

export interface ShowcaseProviderOptions {
  latencyEvery?: number;
  targetEntityIds?: readonly string[];
  impulseStrength?: number;
  arrivalRadius?: number;
}

export class ShowcaseProvider implements LLMProvider {
  readonly name = "showcase";
  readonly decisionLatenciesMs: number[] = [];
  private seq = 0;
  private readonly latencyEvery: number;
  private readonly targetEntityIds?: ReadonlySet<string>;
  private readonly impulseStrength: number;
  private readonly arrivalRadius: number;

  constructor(options: ShowcaseProviderOptions = {}) {
    this.latencyEvery = Math.max(0, Math.floor(options.latencyEvery ?? 5));
    this.targetEntityIds = options.targetEntityIds === undefined ? undefined : new Set(options.targetEntityIds);
    this.impulseStrength = Math.max(0, options.impulseStrength ?? 0.22);
    this.arrivalRadius = Math.max(0, options.arrivalRadius ?? 1.15);
  }

  async decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage: { totalTokens: number } }> {
    const start = Date.now();
    const index = this.seq++;
    if (this.latencyEvery > 0 && index % this.latencyEvery === 0) {
      await ops.op_sleep_ms(1);
    }

    const self = req.perception.selfEntity;
    const position = req.perception.position;
    const target = this.targetEntityIds === undefined
      ? req.perception.nearby[0]
      : req.perception.nearby.find((entity) => this.targetEntityIds?.has(entity.id));
    const toolCalls: MCPRequest[] = [{ tool: "agent.getPerception", input: {} }];

    if (self !== undefined && position !== undefined && target !== undefined && target.distance > this.arrivalRadius) {
      const dx = target.position[0] - position[0];
      const dz = target.position[2] - position[2];
      const len = Math.hypot(dx, dz) || 1;
      toolCalls.push({
        tool: "physics.applyImpulse",
        input: { entity: self, impulse: [dx / len * this.impulseStrength, 0, dz / len * this.impulseStrength] },
      });
    }

    toolCalls.push(
      {
        tool: "agent.emitEvent",
        input: {
          type: "showcase.player_tick",
          payload: {
            agentId: req.perception.selfId,
            tick: req.perception.tick,
            nearby: req.perception.nearby.length,
          },
        },
      },
      { tool: "scene.queryEntities", input: { near: position ?? [0, 0, 0], radius: 14 } },
    );

    this.decisionLatenciesMs.push(Date.now() - start);
    return { toolCalls, usage: { totalTokens: 32 + toolCalls.length * 8 + req.perception.nearby.length } };
  }
}

export function createShowcaseScheduler(): AgentScheduler {
  return new AgentScheduler({
    maxDecisionStartsPerTick: 6,
    maxGlobalActionsPerTick: 12,
    defaultAgentBudget: {
      weight: 1,
      maxQueueDepth: 3,
      maxToolCallsPerDecision: 3,
      maxActionsPerTick: 1,
      decisionTimeoutMs: 100,
    },
  });
}

export function sumQueues(agents: AgentRegistry): number {
  return agents.all().reduce((sum, agent) => sum + agent.queue.length, 0);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function arenaReturnImpulse(x: number, z: number, softRadius = 9.2, strength = 0.32): [number, number, number] | undefined {
  const radius = Math.hypot(x, z);
  if (radius <= softRadius) return undefined;
  const overshoot = radius - softRadius;
  const scale = Math.min(1.4, overshoot * strength);
  return [-x / radius * scale, 0, -z / radius * scale];
}
