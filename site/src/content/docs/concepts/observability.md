---
title: "Observability & the world log"
description: "Limina's EventLoom-shaped event envelope, the sha256 continuous integrity chain, JSONL export, and the durable world log with replay and snapshot recovery."
---

Every meaningful thing that happens in Limina becomes an **event**. Skill calls, permission
decisions, agent perception updates, agent signals — all of them are emitted into a single
ordered stream with a stable, **EventLoom-shaped** envelope, chained with sha256 for
tamper-evidence, and exportable as JSONL. This stream is the **durable world log**: the
substrate for replay, snapshot recovery, and after-the-fact audit.

## The event envelope

Events use the same field names as the EventLoom on-disk format, so a persistence layer can
read Limina's trace with no schema change:

```ts
interface EngineEvent {
  id: string;            // "evt_<actorId>_<seq:012d>_<fnv16>"
  type: string;          // e.g. "skill.executed", "policy.denied"
  actorId: string;       // who acted (an agent or system id)
  threadId: string;      // the session/thread this event belongs to
  parentEventId: string | null;
  causedBy: string[];    // causal parents — the perception → decision → action chain
  timestamp: string;     // ISO 8601
  payload: unknown;      // event-specific data
  integrity?: { hash: string; previousHash: string | null }; // populated on export/append
}
```

A few deliberate choices:

- **The hot path stays hash-free.** `emit` assigns the `id` from a monotonically increasing
  sequence number (12-digit, zero-padded) plus a cheap **non-crypto FNV-1a-16** discriminator
  computed over `{seq, type, actorId, payload}`, and stamps the timestamp. No cryptography
  runs on the frame loop.
- **Causality is first-class.** `parentEventId` and `causedBy` record *why* an event
  happened. A `skill.executed` links the policy decision that allowed it; an agent's decision
  links the `agent.perception.updated` that fed it — so the **perception → decision → action**
  chain is reconstructable.
- **Bounded in memory, complete on disk.** The in-memory tail is bounded (default 8192
  events); the full history is retained for export and flush.

## The sha256 continuous chain

The cryptographic integrity chain is computed lazily — off the frame loop — when the trace is
exported (or appended, when append-on-emit is enabled). Each event's hash folds in the
previous event's hash, forming a genesis-anchored chain:

```text
hashEvent(ev, previousHash) = "sha256:" + sha256( canonicalEvent(ev) + (previousHash ?? "") )

previousHash(0) = null                 // genesis
previousHash(N) = hash(N-1)            // every later event chains the one before it
```

`canonicalEvent` is a deterministic, **sorted-key** stringify of the envelope *excluding* the
`integrity` field itself, so the hash is stable and reproducible. Because each link depends on
all prior links, any edit, reorder, or drop is detectable.

On re-read, integrity verification can fail with a `TraceIntegrityError` whose reason names
exactly what broke: `invalid_json`, `partial_final_line`, `missing_integrity`,
`previous_hash_mismatch`, or `hash_mismatch`.

## JSONL export

Exporting walks the durable history, computes the chain, and writes **one JSON object per
line** — each line a full `EngineEvent` *with* its `integrity: { hash, previousHash }`
populated — newline-joined with a trailing newline (empty when there are no events).

Agents and tools flush the log through the [`trace.export` skill](/skills), which writes a
sandboxed JSONL file and returns `{ name, events, bytes }` (`events` = the durable count,
`bytes` = the content length). The related read skills let callers inspect the live stream:

| Skill | What it does |
|-------|--------------|
| `trace.tail` | Tail events with cursor pagination and optional `actorId` / `type` filters. |
| `trace.explainEvent` | Return an event with its resolved causal parents and children. |
| `trace.export` | Flush durable history to a sandboxed trace JSONL file. |

These reads require no permission, so any agent can inspect the world's history — which is the
whole point of an observable, agent-native engine.

## The durable world log: replay & snapshot recovery

The ordered, chained event stream is what makes the world *durable*. Phase 4 built persistent
shared worlds on top of it:

- **Replay determinism.** Because logic advances only in fixed `dt` steps
  ([the loop](/concepts/loop)), replaying the recorded event stream reproduces the run.
- **Snapshot recovery.** The world can be snapshotted and restored — including the
  [`EntityTable`](/concepts/ecs-and-world)'s identity state (live entries in creation order,
  the `ent_` allocation counter, and the table version) — so a restored world issues the same
  next ids and behaves exactly as the original.
- **Authoritative sync.** The multi-client server owns the fixed-step sim and this same world
  log, applying client intents at tick boundaries in one total order before fanning out
  per-tick deltas.

```text
emit (hash-free, FNV id) ──▶ durable history (full) + bounded in-memory tail
        │                                   │
        │ lazily, off-loop                  ├─▶ trace.tail / trace.explainEvent (read)
        ▼                                   │
  sha256 chain  ──▶ JSONL export (trace.export) ──▶ replay · snapshot recovery · audit
```

:::tip[Logging is how the engine serves any memory backend]
The engine owns the world and its durable log; it does **not** own agent memory. By
persisting the world well, the log feeds any external memory-builder — a vector DB, an
EventLoom/Zaxy persistence layer, or none — without the engine taking on a memory dependency.
:::

## Related

- [Observability pillar](/pillars/observability) — the trace as a product surface.
- [The fixed-timestep loop](/concepts/loop) — why the recorded stream replays deterministically.
- [Perception](/concepts/perception) — the `agent.perception.updated` events that anchor the
  causal chain.
