// AgentRecord + AgentRegistry. Agents are JS-side records (strings/llm config
// aren't SoA-friendly); a player optionally inhabits an `ent_` entity.

import type { MCPRequest } from "../mcp/protocol.ts";
import type { AgentLookup } from "../skills/registry.ts";

export interface PerceivedEntity {
  id: string;
  position: [number, number, number];
  distance: number;
}

export interface Perception {
  selfId: string;
  selfEntity?: string;
  position?: [number, number, number];
  nearby: PerceivedEntity[];
  recentEvents: { type: string }[];
  tick: number;
}

export interface AgentRecord {
  id: string; // agt_
  type: "builder" | "player";
  entityId?: string; // ent_ the agent inhabits
  perceptionRadius: number;
  decisionIntervalTicks: number;
  profile: string; // permission profile name
  sessionId: string;
  llm: { provider: string; model: string; systemPrompt: string };
  // runtime state
  perception?: Perception;
  lastPerceptionEventId?: string;
  inFlight: boolean;
  lastDecisionTick: number;
  queue: QueuedAction[];
}

/** A validated tool call awaiting execution, tagged with the decision that
 *  produced it (for the perception -> decision -> action causal chain). */
export interface QueuedAction {
  req: MCPRequest;
  decisionId: string;
}

export interface NewAgent {
  id: string;
  type: "builder" | "player";
  entityId?: string;
  perceptionRadius?: number;
  decisionIntervalTicks?: number;
  profile: string;
  sessionId: string;
  llm: { provider: string; model: string; systemPrompt: string };
}

export class AgentRegistry implements AgentLookup {
  private readonly agents = new Map<string, AgentRecord>();

  add(spec: NewAgent): AgentRecord {
    const record: AgentRecord = {
      id: spec.id,
      type: spec.type,
      entityId: spec.entityId,
      perceptionRadius: spec.perceptionRadius ?? 15,
      decisionIntervalTicks: spec.decisionIntervalTicks ?? 30,
      profile: spec.profile,
      sessionId: spec.sessionId,
      llm: spec.llm,
      inFlight: false,
      lastDecisionTick: -(spec.decisionIntervalTicks ?? 30), // due immediately
      queue: [],
    };
    this.agents.set(record.id, record);
    return record;
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }
  all(): AgentRecord[] {
    return [...this.agents.values()];
  }
  getPerception(agentId: string): unknown {
    return this.agents.get(agentId)?.perception ?? null;
  }
}
