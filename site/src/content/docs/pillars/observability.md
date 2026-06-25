---
title: "Observability"
description: "The typed event bus, causal trace trees, the sha256 chain, and JSONL export."
---

Every significant action by a builder or player is observable, traceable, and replayable. Observability is not a side feature in Limina — it is the **durable world log**, one of the four things the engine owns (world, perception, skill surface, log). The brain and its memory live outside; the engine's job is to record what happened, faithfully and verifiably.

:::note
This page is the **pillar / usage** view: the APIs and skills you use to read and export traces. For the higher-level idea — *why* the world log is the substrate that any memory backend can build on — see the [Observability concept](/concepts/observability).
:::

## The typed event bus

Every skill execution, component change, agent decision, and perception update emits an event. Events are immutable and EventLoom-shaped — the same field names as the on-disk format a persistence layer expects, so it can be read with no schema change:

```ts
interface EngineEvent {
  id: string;                  // "evt_<actorId>_<seq:012d>_<fnv16>"
  type: string;               // e.g. "skill.executed", "agent.decision.made"
  actorId: string;
  threadId: string;
  parentEventId: string | null;
  causedBy: string[];          // causal parents — builds the trace tree
  timestamp: string;           // ISO 8601
  payload: unknown;
  integrity?: { hash: string; previousHash: string | null }; // on export/append
}
```

The hot path stays hash-free. `emit()` assigns the `id` from a monotonically increasing sequence number (12-digit zero-padded) plus a cheap **non-crypto FNV-1a-16** discriminator computed over `{ seq, type, actorId, payload }`, and sets the timestamp. No hashing happens on the frame loop. The in-memory tail is bounded (default 8192 events); full history is retained in `durableEvents` for export.

Typical event types include `skill.executed`, `agent.decision.made`, `ecs.component.added`, `three.material.updated`, `policy.decision` / `policy.denied`, and `security.permission.denied`.

## Causal trace trees (`causedBy`)

The trace is not a flat log — it is a causal tree. `parentEventId` gives an event its lineage; `causedBy` links the explicit parents that produced it. A player's full decision chain reads `perception → decision → tool call → state change`, each event linking back to the one that caused it. Two skills make the tree queryable:

| skill | input | returns |
|---|---|---|
| `trace.tail` | `afterSeq?`, `limit?`, `actorId?`, `type?` | `events`, `nextAfterSeq` — cursor-paginated, optionally filtered |
| `trace.explainEvent` | `eventId` | the `event` plus resolved `parents[]` and `children[]` |

Because builder sessions can spawn player agents, a builder trace naturally contains the sub-traces of the agents it created — hierarchical by construction.

## The sha256 integrity chain

On export the durable history is sealed into a genesis-anchored hash chain:

```
hashEvent(ev, previousHash) = "sha256:" + sha256(canonicalEvent(ev) + (previousHash ?? ""))
```

`canonicalEvent` is a deterministic, sorted-key stringify of the event's fields (the `integrity` field itself is excluded from its own hash input). The first event's `previousHash` is `null`; thereafter `previousHash(N) = hash(N-1)`. When append-on-emit is enabled, each event is hashed and appended immediately and the chain advances live; otherwise the chain is computed lazily at export time — keeping cryptographic work off the frame loop.

Re-reading a trace verifies the chain and fails loudly on tampering or truncation, with a `TraceIntegrityError` whose reason is one of: `invalid_json`, `partial_final_line`, `missing_integrity`, `previous_hash_mismatch`, `hash_mismatch`.

## JSONL export

`exportJsonl()` walks the durable events, computes the chain, and emits one JSON object per line — each line a full `EngineEvent` **with** its `integrity: { hash, previousHash }` populated — joined by newlines. The `trace.export { name }` skill flushes that content to a sandboxed `.jsonl` file and returns `{ name, events, bytes }` (`events` = durable count, `bytes` = content length). This is the durable, replayable artifact: a complete, hash-chained record of a session.

## Inspector / devtools

For a live snapshot rather than a stream, `inspector.snapshot` returns a bounded, paginated view of the world: entities (with transforms, tags, physics, resources), agents, registered skills, the caller's permissions and profiles, resource counts, and trace metadata. The lighter `inspect()` tracer call returns the thread id, event count, the set of actors seen, and the recent tail:

```ts
interface InspectorSnapshot {
  threadId: string;
  eventCount: number;
  actors: string[];
  recent: EngineEvent[];
}
```

The agent-ops HUD in the windowed demos is fed directly from this real tracer feed — what you see on screen is the actual recorded trace, not a mock.

## Replay window

Events are sequenced and timestamped, so an agent's recent history can be replayed over a short window for debugging a builder session or a player's behavior. `tracer.trace(actorId, sinceTick?)` returns one actor's recent events; combined with `trace.explainEvent` you can reconstruct exactly why an agent did what it did, and with the sha256 chain you can prove the record was never altered.
