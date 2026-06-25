// limina AUDIT SURFACE (Phase 4b / M8) — the reviewer query layer that answers
// "why was action X allowed/denied" from the REAL recorded trace, never a
// fabricated reconstruction.
//
// Every M7 boundary crossing records a `policy.decision` (allow) / `policy.denied`
// (deny) event carrying the rule that fired, the reason, the salient context, and
// the live quota/budget snapshot; on an ALLOW the registry links that decision
// into the resulting `skill.executed` (and the sandbox crossing) via `causedBy`.
// So for any action event the audit walks the recorded causal chain to its policy
// decision, reads the provenance off the event envelope, and returns the ancestry
// — all three straight out of the durable trace.
//
//   audit.explain { eventId }  -> { decision, provenance, causalTrace } for one action
//   audit.query   { filter }   -> policy decisions/denials, package provenance, by rule/cap
//   audit.usage   { sessionId } -> resource usage (call counts + quota/budget snapshots)

import { z } from "../../build/zod.bundle.mjs";
import type { EngineEvent, LiminaTracer, TraceReplayResult } from "../observability/event.ts";
import type { SkillRegistry } from "../skills/registry.ts";

const POLICY_TYPES: Record<string, true> = { "policy.decision": true, "policy.denied": true };

/** The recorded policy-event payload — parsed (not inline-cast) before any read so
 *  a malformed/foreign payload degrades to `null` instead of a silent wrong read. */
const policyPayloadSchema = z.object({
  boundary: z.string(),
  cap: z.string(),
  allow: z.boolean(),
  rule: z.string(),
  reason: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  profile: z.string().nullable().optional(),
  package: z.string().nullable().optional(),
  requiredPermissions: z.array(z.string()).nullable().optional(),
  tick: z.number().nullable().optional(),
  quota: z.unknown().optional(),
  budget: z.unknown().optional(),
});

type PolicyPayload = z.infer<typeof policyPayloadSchema>;

interface AncestorRef {
  id: string;
  type: string;
  actorId: string;
  threadId: string;
}

function parsePolicy(ev: EngineEvent): PolicyPayload | undefined {
  if (POLICY_TYPES[ev.type] === undefined) return undefined;
  const parsed = policyPayloadSchema.safeParse(ev.payload);
  return parsed.success ? parsed.data : undefined;
}

/** All ancestors of `startId` (transitive causedBy/parent), nearest-first. */
function ancestry(replay: TraceReplayResult, startId: string): EngineEvent[] {
  const seen = new Set<string>([startId]);
  const out: EngineEvent[] = [];
  let frontier = [...(replay.parentsById.get(startId) ?? [])];
  while (frontier.length > 0) {
    const next: EngineEvent[] = [];
    for (const parent of frontier) {
      if (seen.has(parent.id)) continue;
      seen.add(parent.id);
      out.push(parent);
      for (const grand of replay.parentsById.get(parent.id) ?? []) next.push(grand);
    }
    frontier = next;
  }
  return out;
}

/** The nearest policy decision governing an action: the event itself if it IS a
 *  policy event, else its nearest policy ancestor (preferring a matching cap). */
function governingDecision(replay: TraceReplayResult, event: EngineEvent): EngineEvent | undefined {
  if (POLICY_TYPES[event.type] !== undefined) return event;
  const cap = (() => {
    if (event.payload !== null && typeof event.payload === "object") {
      const p = event.payload;
      if ("cap" in p && typeof p.cap === "string") return p.cap;
      if ("skill" in p && typeof p.skill === "string") return p.skill;
    }
    return undefined;
  })();
  let capMatch: EngineEvent | undefined;
  let firstPolicy: EngineEvent | undefined;
  for (const ancestor of ancestry(replay, event.id)) {
    if (POLICY_TYPES[ancestor.type] === undefined) continue;
    if (firstPolicy === undefined) firstPolicy = ancestor;
    if (cap !== undefined && capMatch === undefined) {
      const parsed = parsePolicy(ancestor);
      if (parsed?.cap === cap) capMatch = ancestor;
    }
  }
  return capMatch ?? firstPolicy;
}

const eventRef = (ev: EngineEvent): AncestorRef => ({ id: ev.id, type: ev.type, actorId: ev.actorId, threadId: ev.threadId });

export function registerAuditSkills(registry: SkillRegistry): void {
  // The registry's tracer is concretely a LiminaTracer (the audit needs its
  // causal-replay + tail surface, which the minimal Tracer interface omits).
  const tracer = registry.tracer as LiminaTracer;

  registry.register({
    name: "audit.explain",
    version: "1.0.0",
    description: "Answer 'why was action X allowed/denied': the governing policy decision (rule + reason + context + quota/budget), the provenance (agent/session/profile/package), and the causal-parent chain — all from the real recorded trace.",
    category: "system",
    permissions: [],
    input: z.object({ eventId: z.string() }),
    output: z.object({
      eventId: z.string(),
      eventType: z.string(),
      found: z.boolean(),
      decision: z.object({
        eventId: z.string(),
        allow: z.boolean(),
        rule: z.string(),
        reason: z.string(),
        boundary: z.string(),
        context: z.object({
          agentId: z.string(),
          sessionId: z.string(),
          cap: z.string(),
          profile: z.string().nullable(),
          package: z.string().nullable(),
          tick: z.number().nullable(),
          requiredPermissions: z.array(z.string()).nullable(),
        }),
        quota: z.unknown().nullable(),
        budget: z.unknown().nullable(),
      }).nullable(),
      provenance: z.object({
        agentId: z.string(),
        sessionId: z.string(),
        profile: z.string().nullable(),
        package: z.string().nullable(),
      }),
      causalTrace: z.object({
        parents: z.array(z.object({ id: z.string(), type: z.string(), actorId: z.string(), threadId: z.string() })),
        ancestry: z.array(z.object({ id: z.string(), type: z.string(), actorId: z.string(), threadId: z.string() })),
      }),
    }),
    handler: (input) => {
      const replay = tracer.replay();
      const event = replay.byId.get(input.eventId);
      if (event === undefined) throw new Error(`unknown event: ${input.eventId}`);
      const decisionEvent = governingDecision(replay, event);
      const decisionPayload = decisionEvent !== undefined ? parsePolicy(decisionEvent) : undefined;
      const decision = decisionEvent !== undefined && decisionPayload !== undefined
        ? {
          eventId: decisionEvent.id,
          allow: decisionPayload.allow,
          rule: decisionPayload.rule,
          reason: decisionPayload.reason,
          boundary: decisionPayload.boundary,
          context: {
            agentId: decisionPayload.agentId,
            sessionId: decisionPayload.sessionId,
            cap: decisionPayload.cap,
            profile: decisionPayload.profile ?? null,
            package: decisionPayload.package ?? null,
            tick: decisionPayload.tick ?? null,
            requiredPermissions: decisionPayload.requiredPermissions ?? null,
          },
          quota: decisionPayload.quota ?? null,
          budget: decisionPayload.budget ?? null,
        }
        : null;
      return {
        eventId: event.id,
        eventType: event.type,
        found: decision !== null,
        decision,
        provenance: {
          agentId: event.actorId,
          sessionId: event.threadId,
          profile: decisionPayload?.profile ?? null,
          package: decisionPayload?.package ?? null,
        },
        causalTrace: {
          parents: (replay.parentsById.get(event.id) ?? []).map(eventRef),
          ancestry: ancestry(replay, event.id).map(eventRef),
        },
      };
    },
  });

  registry.register({
    name: "audit.query",
    version: "1.0.0",
    description: "Query recorded policy decisions: filter by allow/deny, cap, rule, agent, session, or package (package provenance). Returns matching decision events plus an allow/deny + by-rule + by-cap summary.",
    category: "system",
    permissions: [],
    input: z.object({
      decision: z.enum(["allow", "deny", "all"]).default("all"),
      cap: z.string().optional(),
      rule: z.string().optional(),
      agentId: z.string().optional(),
      sessionId: z.string().optional(),
      package: z.string().optional(),
      limit: z.number().int().min(0).max(2000).default(200),
    }),
    output: z.object({
      summary: z.object({
        total: z.number().int(),
        allowed: z.number().int(),
        denied: z.number().int(),
        byRule: z.record(z.string(), z.number()),
        byCap: z.record(z.string(), z.number()),
        packages: z.array(z.string()),
      }),
      decisions: z.array(z.object({
        eventId: z.string(),
        allow: z.boolean(),
        rule: z.string(),
        reason: z.string(),
        boundary: z.string(),
        cap: z.string(),
        agentId: z.string(),
        sessionId: z.string(),
        profile: z.string().nullable(),
        package: z.string().nullable(),
        tick: z.number().nullable(),
      })),
    }),
    handler: (input) => {
      const replay = tracer.replay();
      const byRule: Record<string, number> = {};
      const byCap: Record<string, number> = {};
      const packages = new Set<string>();
      let allowed = 0;
      let denied = 0;
      const matched: PolicyPayload[] = [];
      const matchedIds: string[] = [];
      for (const ev of replay.events) {
        const p = parsePolicy(ev);
        if (p === undefined) continue;
        if (input.decision === "allow" && !p.allow) continue;
        if (input.decision === "deny" && p.allow) continue;
        if (input.cap !== undefined && p.cap !== input.cap) continue;
        if (input.rule !== undefined && p.rule !== input.rule) continue;
        if (input.agentId !== undefined && p.agentId !== input.agentId) continue;
        if (input.sessionId !== undefined && p.sessionId !== input.sessionId) continue;
        if (input.package !== undefined && (p.package ?? null) !== input.package) continue;
        if (p.allow) allowed++; else denied++;
        byRule[p.rule] = (byRule[p.rule] ?? 0) + 1;
        byCap[p.cap] = (byCap[p.cap] ?? 0) + 1;
        if (p.package != null) packages.add(p.package);
        matched.push(p);
        matchedIds.push(ev.id);
      }
      const decisions = matched.slice(0, input.limit).map((p, i) => ({
        eventId: matchedIds[i],
        allow: p.allow,
        rule: p.rule,
        reason: p.reason,
        boundary: p.boundary,
        cap: p.cap,
        agentId: p.agentId,
        sessionId: p.sessionId,
        profile: p.profile ?? null,
        package: p.package ?? null,
        tick: p.tick ?? null,
      }));
      return {
        summary: { total: matched.length, allowed, denied, byRule, byCap, packages: [...packages] },
        decisions,
      };
    },
  });

  registry.register({
    name: "audit.usage",
    version: "1.0.0",
    description: "Resource usage from recorded decisions: allowed/denied call counts per session+cap, plus the latest quota and budget snapshots seen for each session — derived from the real policy events.",
    category: "system",
    permissions: [],
    input: z.object({ sessionId: z.string().optional() }),
    output: z.object({
      perSessionCap: z.array(z.object({
        sessionId: z.string(),
        cap: z.string(),
        allowed: z.number().int(),
        denied: z.number().int(),
      })),
      quotas: z.array(z.object({ sessionId: z.string(), quota: z.unknown() })),
      budgets: z.array(z.object({ sessionId: z.string(), budget: z.unknown() })),
    }),
    handler: (input) => {
      const replay = tracer.replay();
      const counts = new Map<string, { sessionId: string; cap: string; allowed: number; denied: number }>();
      const latestQuota = new Map<string, unknown>();
      const latestBudget = new Map<string, unknown>();
      for (const ev of replay.events) {
        const p = parsePolicy(ev);
        if (p === undefined) continue;
        if (input.sessionId !== undefined && p.sessionId !== input.sessionId) continue;
        const key = `${p.sessionId}::${p.cap}`;
        const row = counts.get(key) ?? { sessionId: p.sessionId, cap: p.cap, allowed: 0, denied: 0 };
        if (p.allow) row.allowed++; else row.denied++;
        counts.set(key, row);
        if (p.quota != null) latestQuota.set(p.sessionId, p.quota);
        if (p.budget != null) latestBudget.set(p.sessionId, p.budget);
      }
      return {
        perSessionCap: [...counts.values()],
        quotas: [...latestQuota.entries()].map(([sessionId, quota]) => ({ sessionId, quota })),
        budgets: [...latestBudget.entries()].map(([sessionId, budget]) => ({ sessionId, budget })),
      };
    },
  });
}
