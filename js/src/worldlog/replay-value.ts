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
