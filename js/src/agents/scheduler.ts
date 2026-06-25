import type { Tracer } from "../observability/event.ts";
import type { AgentRecord } from "./agent.ts";

export interface AgentBudget {
  weight: number;
  maxQueueDepth: number;
  maxToolCallsPerDecision: number;
  maxActionsPerTick: number;
  decisionTimeoutMs: number;
}

export interface SchedulerBudget {
  maxDecisionStartsPerTick: number;
  maxGlobalActionsPerTick: number;
  defaultAgentBudget: AgentBudget;
  agents?: Record<string, Partial<AgentBudget>>;
}

export interface AgentRuntimeState {
  agentId: string;
  generation: number;
  inFlightGeneration: number | null;
  lastTimedOutGeneration: number | null;
  decisionDeadlineMs: number | null;
  deficit: number;
  actionsExecutedThisTick: number;
  actionTick: number;
}

export interface DecisionAdmission {
  agent: AgentRecord;
  generation: number;
}

const DEFAULT_AGENT_BUDGET: AgentBudget = {
  weight: 1,
  maxQueueDepth: Number.MAX_SAFE_INTEGER,
  maxToolCallsPerDecision: Number.MAX_SAFE_INTEGER,
  maxActionsPerTick: 1,
  decisionTimeoutMs: Number.POSITIVE_INFINITY,
};

const DEFAULT_SCHEDULER_BUDGET: SchedulerBudget = {
  maxDecisionStartsPerTick: Number.MAX_SAFE_INTEGER,
  maxGlobalActionsPerTick: Number.MAX_SAFE_INTEGER,
  defaultAgentBudget: DEFAULT_AGENT_BUDGET,
};

function asPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function ordered(agents: AgentRecord[]): AgentRecord[] {
  return [...agents].sort((a, b) => a.id.localeCompare(b.id));
}

export class AgentScheduler {
  private readonly budget: SchedulerBudget;
  private readonly states = new Map<string, AgentRuntimeState>();
  private decisionCursor = 0;

  constructor(budget: Partial<SchedulerBudget> = {}) {
    this.budget = {
      maxDecisionStartsPerTick: budget.maxDecisionStartsPerTick ?? DEFAULT_SCHEDULER_BUDGET.maxDecisionStartsPerTick,
      maxGlobalActionsPerTick: budget.maxGlobalActionsPerTick ?? DEFAULT_SCHEDULER_BUDGET.maxGlobalActionsPerTick,
      defaultAgentBudget: { ...DEFAULT_AGENT_BUDGET, ...budget.defaultAgentBudget },
      agents: budget.agents ?? {},
    };
  }

  agentBudget(agent: AgentRecord): AgentBudget {
    return { ...this.budget.defaultAgentBudget, ...(this.budget.agents?.[agent.id] ?? {}) };
  }

  runtimeState(agent: AgentRecord): AgentRuntimeState {
    let state = this.states.get(agent.id);
    if (state === undefined) {
      state = {
        agentId: agent.id,
        generation: 0,
        inFlightGeneration: null,
        lastTimedOutGeneration: null,
        decisionDeadlineMs: null,
        deficit: 0,
        actionsExecutedThisTick: 0,
        actionTick: -1,
      };
      this.states.set(agent.id, state);
    }
    return state;
  }

  admitDecisions(
    agents: AgentRecord[],
    tick: number,
    tracer: Tracer,
    isDue: (agent: AgentRecord) => boolean,
  ): DecisionAdmission[] {
    const candidates = ordered(agents).filter((agent) => !agent.inFlight && agent.perception !== undefined && isDue(agent));
    const cap = asPositiveInt(this.budget.maxDecisionStartsPerTick, Number.MAX_SAFE_INTEGER);
    if (candidates.length === 0 || cap === 0) {
      if (candidates.length > 0) {
        for (const agent of candidates) this.emitBackpressure(tracer, agent, tick, "decision_start_cap", { cap });
      }
      return [];
    }

    const admitted: DecisionAdmission[] = [];
    let visits = 0;
    while (admitted.length < cap && visits < candidates.length * 2) {
      const index = this.decisionCursor % candidates.length;
      const agent = candidates[index];
      const state = this.runtimeState(agent);
      const budget = this.agentBudget(agent);
      state.deficit += Math.max(1, Math.floor(budget.weight));
      if (state.deficit >= 1) {
        state.deficit -= 1;
        const generation = ++state.generation;
        state.inFlightGeneration = generation;
        admitted.push({ agent, generation });
        this.emit(tracer, agent, "agent.scheduled", {
          tick,
          generation,
          queueDepth: agent.queue.length,
          maxQueueDepth: budget.maxQueueDepth,
        });
      }
      this.decisionCursor = (index + 1) % candidates.length;
      visits++;
    }

    if (admitted.length < candidates.length) {
      const admittedIds = new Set(admitted.map((item) => item.agent.id));
      for (const agent of candidates) {
        if (!admittedIds.has(agent.id)) {
          this.emitBackpressure(tracer, agent, tick, "decision_start_cap", { cap, candidates: candidates.length });
        }
      }
    }
    return admitted;
  }

  /** Record the wall-clock deadline for an in-flight decision. Detection is
   *  performed synchronously by `sweepDecisionTimeouts` each tick rather than via
   *  a real `op_sleep_ms` timer: a pending watchdog timer keeps the host event
   *  loop non-idle, and the windowed host drains the loop every frame, so a
   *  per-decision timer stalled each frame for the full timeout (~100ms -> 9fps).
   *  A swept deadline keeps the exact timeout semantics with zero host-blocking. */
  armDecisionTimeout(agent: AgentRecord, generation: number): void {
    const state = this.runtimeState(agent);
    if (state.inFlightGeneration !== generation) return;
    const timeoutMs = this.agentBudget(agent).decisionTimeoutMs;
    state.decisionDeadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;
  }

  /** Expire in-flight decisions whose deadline has passed. Mirrors the old
   *  timer's effect (mark the generation timed out, clear in-flight, emit
   *  `agent.budget.exceeded`) so late tool calls from the stale generation are
   *  still rejected by the generation guard in `completeDecision`. */
  sweepDecisionTimeouts(agents: AgentRecord[], tick: number, tracer: Tracer, now: number = Date.now()): void {
    for (const agent of agents) {
      const state = this.states.get(agent.id);
      if (state === undefined || state.inFlightGeneration === null || state.decisionDeadlineMs === null) continue;
      if (now < state.decisionDeadlineMs) continue;
      const generation = state.inFlightGeneration;
      state.lastTimedOutGeneration = generation;
      state.inFlightGeneration = null;
      state.decisionDeadlineMs = null;
      agent.inFlight = false;
      this.emit(tracer, agent, "agent.budget.exceeded", {
        tick,
        generation,
        budget: "decisionTimeoutMs",
        limit: this.agentBudget(agent).decisionTimeoutMs,
      });
    }
  }

  completeDecision(agent: AgentRecord, generation: number): boolean {
    const state = this.runtimeState(agent);
    if (state.inFlightGeneration !== generation) return false;
    state.inFlightGeneration = null;
    state.decisionDeadlineMs = null;
    agent.inFlight = false;
    return true;
  }

  failDecision(agent: AgentRecord, generation: number): boolean {
    return this.completeDecision(agent, generation);
  }

  enqueueDecisionToolCalls(
    agent: AgentRecord,
    generation: number,
    decisionId: string,
    calls: { req: AgentRecord["queue"][number]["req"]; valid: boolean; reject?: () => void }[],
    tracer: Tracer,
    tick: number,
  ): void {
    if (!this.completeDecision(agent, generation)) return;
    const budget = this.agentBudget(agent);
    const callCap = asPositiveInt(budget.maxToolCallsPerDecision, Number.MAX_SAFE_INTEGER);
    const queueCap = asPositiveInt(budget.maxQueueDepth, Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (!call.valid) {
        call.reject?.();
        continue;
      }
      if (i >= callCap) {
        this.emitDrop(tracer, agent, tick, decisionId, "tool_call_cap", {
          generation,
          index: i,
          maxToolCallsPerDecision: callCap,
        });
        continue;
      }
      if (agent.queue.length >= queueCap) {
        this.emitDrop(tracer, agent, tick, decisionId, "queue_full", {
          generation,
          queueDepth: agent.queue.length,
          maxQueueDepth: queueCap,
        });
        continue;
      }
      agent.queue.push({ req: call.req, decisionId });
    }
  }

  canExecuteAction(agent: AgentRecord, tick: number, globalExecuted: number, tracer: Tracer): boolean {
    const globalCap = asPositiveInt(this.budget.maxGlobalActionsPerTick, Number.MAX_SAFE_INTEGER);
    if (globalExecuted >= globalCap) {
      this.emitBackpressure(tracer, agent, tick, "global_action_cap", { maxGlobalActionsPerTick: globalCap });
      return false;
    }
    const state = this.runtimeState(agent);
    if (state.actionTick !== tick) {
      state.actionTick = tick;
      state.actionsExecutedThisTick = 0;
    }
    const agentCap = asPositiveInt(this.agentBudget(agent).maxActionsPerTick, Number.MAX_SAFE_INTEGER);
    if (state.actionsExecutedThisTick >= agentCap) {
      this.emitBackpressure(tracer, agent, tick, "agent_action_cap", { maxActionsPerTick: agentCap });
      return false;
    }
    state.actionsExecutedThisTick++;
    return true;
  }

  emitActionExecuted(tracer: Tracer, agent: AgentRecord, tick: number, tool: string, decisionId: string, success: boolean): void {
    this.emit(tracer, agent, "agent.action.executed", { tick, tool, decisionId, success });
  }

  private emitDrop(
    tracer: Tracer,
    agent: AgentRecord,
    tick: number,
    decisionId: string,
    reason: string,
    payload: Record<string, unknown>,
  ): void {
    this.emit(tracer, agent, "agent.queue.dropped", { tick, reason, decisionId, ...payload });
    this.emitBackpressure(tracer, agent, tick, reason, payload);
  }

  private emitBackpressure(tracer: Tracer, agent: AgentRecord, tick: number, reason: string, payload: Record<string, unknown>): void {
    this.emit(tracer, agent, "agent.backpressure.applied", { tick, reason, ...payload });
  }

  private emit(tracer: Tracer, agent: AgentRecord, type: string, payload: unknown): string {
    return tracer.emit({
      type,
      actorId: agent.id,
      threadId: agent.sessionId,
      parentEventId: null,
      causedBy: [],
      payload,
    });
  }
}

export const defaultAgentScheduler = new AgentScheduler();
