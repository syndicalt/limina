/** Collapse -0 to +0 throughout a skill input, so the value the handler APPLIES is
 *  byte-identical to its JSON-serialized twin. JSON has no -0 (`JSON.stringify(-0) ===
 *  "0"`), so without this an input carrying -0 (e.g. `Math.round(-0.2)` from a gizmo
 *  drag) makes IN-MEMORY replay store -0 while DISK replay stores +0 — a determinism
 *  divergence `compareWorldState` (Object.is) flags as the confusing "pos[0] diverged:
 *  0 vs 0". Applied at the ONE point that feeds both the handler and the recorded
 *  command (the registry's normalized input), so live == memory-replay == disk-replay.
 *  Zod already rejects NaN/Infinity for z.number(), so -0 is the only value that
 *  reaches here needing canonicalization.
 *
 *  PURE with structural sharing: a new array/object is allocated ONLY along the path
 *  to an actual -0; every subtree with no -0 is returned by reference, UNCHANGED. This
 *  is deliberate — skill inputs routinely carry FROZEN objects (the architecture
 *  compiler freezes placements/volumes it emits), and an in-place rewrite would throw
 *  "cannot assign to read only property" on them. -0 is rare, so the common case does
 *  zero allocation and never touches the input.
 *
 *  CYCLE-SAFE: a self-referential input must NOT stack-overflow this walker (skill
 *  inputs can be circular — cloneReplayValue rejects them with a clean error DOWNSTREAM,
 *  at commit; a crash here would abort the whole invoke first). The `seen` set breaks
 *  cycles by returning a revisited node unchanged; it is add/deleted around each node
 *  (like cloneReplayValue) so a DAG (same object at sibling positions) is still walked. */
export function canonicalizeNegativeZero(value: unknown, seen: Set<object> = new Set()): unknown {
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value; // cycle: stop recursing, return as-is
  seen.add(value);
  let result: unknown = value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const canonical = canonicalizeNegativeZero(value[i], seen);
      out[i] = canonical;
      if (!Object.is(canonical, value[i])) changed = true;
    }
    result = changed ? out : value;
  } else {
    const record = value as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const canonical = canonicalizeNegativeZero(record[key], seen);
      out[key] = canonical;
      if (!Object.is(canonical, record[key])) changed = true;
    }
    result = changed ? out : value;
  }
  seen.delete(value);
  return result;
}

// Authoritative command values must have one stable JSON-compatible identity.
// Reject shapes that cannot be replayed faithfully instead of allowing JSON to
// silently coerce or discard them.
export function cloneReplayValue(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "number" || type === "string" || type === "boolean" || type === "undefined") return value;
  if (type === "bigint") throw new Error("cannot record a BigInt value (not replay-serializable)");
  if (type === "function" || type === "symbol") throw new Error(`cannot record a ${type} value`);
  const object = value as object;
  if (seen.has(object)) throw new Error("cannot record a circular value");
  seen.add(object);

  const toJSON = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    seen.delete(object);
    return cloneReplayValue((toJSON as () => unknown).call(object), seen);
  }

  let clone: unknown;
  if (Array.isArray(object)) {
    const array = new Array<unknown>(object.length);
    for (let i = 0; i < object.length; i++) array[i] = cloneReplayValue((object as unknown[])[i], seen);
    clone = array;
  } else {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const item = cloneReplayValue((object as Record<string, unknown>)[key], seen);
      if (item !== undefined) record[key] = item;
    }
    clone = record;
  }
  seen.delete(object);
  return clone;
}
