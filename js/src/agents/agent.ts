// AgentRecord + AgentRegistry. Agents are JS-side records (strings/llm config
// aren't SoA-friendly); a player optionally inhabits an `ent_` entity.

import type { MCPRequest } from "../mcp/protocol.ts";
import type { AgentLookup } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";

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
  /** Optional dynamic capability BUNDLE — a least-privilege set assigned per task
   *  (e.g. by a coordinator's delegate). When present it governs BOTH exposure and
   *  invocation (via agentGrants); absent -> the profile's grants. */
  bundle?: ReadonlySet<string>;
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
  bundle?: ReadonlySet<string>;
  sessionId: string;
  llm: { provider: string; model: string; systemPrompt: string };
}

/** Cache of profile-name -> resolved grants. `resolveProfile` allocates a fresh
 *  Set from the immutable PERMISSION_PROFILES table on every call, and this runs
 *  per decision AND per action; the table never changes at runtime, so the grants
 *  for a given name are stable. Memoizing turns the hot-path resolve into a Map
 *  lookup while returning byte-identical grants (same insertion order). */
const profileGrants = new Map<string, ReadonlySet<string>>();

/** The capability grants that govern an agent — its dynamic bundle if assigned,
 *  else its profile's grants. The SINGLE source for both what the agent SEES
 *  (registry.list) and what it can INVOKE (InvokeBase.permissions). */
export function agentGrants(agent: { profile: string; bundle?: ReadonlySet<string> }): ReadonlySet<string> {
  if (agent.bundle != null) return agent.bundle;
  let grants = profileGrants.get(agent.profile);
  if (grants === undefined) {
    grants = resolveProfile(agent.profile);
    profileGrants.set(agent.profile, grants);
  }
  return grants;
}

export class AgentRegistry implements AgentLookup {
  private readonly agents = new Map<string, AgentRecord>();
  /** Cached snapshots of the agent set. `all()` is called several times per tick
   *  and `ordered()` feeds the action sweep's deterministic id-sort; membership
   *  only changes on `add`/`clear`, so both snapshots stay valid until then. */
  private allCache?: AgentRecord[];
  private orderedCache?: AgentRecord[];

  private invalidate(): void {
    this.allCache = undefined;
    this.orderedCache = undefined;
  }

  add(spec: NewAgent): AgentRecord {
    const record: AgentRecord = {
      id: spec.id,
      type: spec.type,
      entityId: spec.entityId,
      perceptionRadius: spec.perceptionRadius ?? 15,
      decisionIntervalTicks: spec.decisionIntervalTicks ?? 30,
      profile: spec.profile,
      bundle: spec.bundle,
      sessionId: spec.sessionId,
      llm: spec.llm,
      inFlight: false,
      lastDecisionTick: -(spec.decisionIntervalTicks ?? 30), // due immediately
      queue: [],
    };
    this.agents.set(record.id, record);
    this.invalidate();
    return record;
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }
  /** All registered agents, memoized per membership change. Callers must treat the
   *  result as read-only: never sort/splice/push it, as that would poison the shared
   *  per-tick cache (mirrors `ordered()`). Copy first if you need to mutate. */
  all(): AgentRecord[] {
    if (this.allCache === undefined) this.allCache = [...this.agents.values()];
    return this.allCache;
  }
  /** Agents in the deterministic id-sorted order the action sweep drains, cached
   *  alongside `all()` so the per-tick sort is recomputed only on membership change.
   *  Same comparator as the previous inline `all().sort(...)`, so ordering is
   *  byte-identical. Callers must treat the result as read-only. */
  ordered(): AgentRecord[] {
    if (this.orderedCache === undefined) {
      this.orderedCache = [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    return this.orderedCache;
  }
  /** Forget every registered agent. Used by demo coordinators that reset their
   *  world between runs so a fresh build does not inherit prior workers. */
  clear(): void {
    this.agents.clear();
    this.invalidate();
  }
  getPerception(agentId: string): unknown {
    return this.agents.get(agentId)?.perception ?? null;
  }
}
