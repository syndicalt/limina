// design-api.js — client for the headless design sidecar, reached only through the launcher
// proxy's same-origin /api/* forward. The proxy attaches the session token server-side, so
// nothing here may carry credentials and every URL must stay relative — an absolute URL would
// bypass the proxy (and the token). Pure and dependency-free so node --test can drive it with
// an injected fetch. Failure contract: every non-success surfaces as DesignApiError — .status
// is the HTTP status, or 0 for network/timeout; .body is truncated so an error page echoing a
// vault doc can't bloat panel state or logs.

const BODY_LIMIT = 512;

export class DesignApiError extends Error {
  constructor(message, { status = 0, body = "", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DesignApiError";
    this.status = status;
    this.body = String(body).slice(0, BODY_LIMIT);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(label + " must be a non-empty string");
  }
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string") throw new TypeError(label + " must be a string");
  return value;
}

function nonEmptyObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be a plain object");
  }
  return value;
}

function nonEmptyMapList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new TypeError("maps must be an array of 1-256 map docs");
  }
  return value;
}

function causeMessage(cause) {
  return cause && cause.message ? cause.message : String(cause);
}

export function createDesignApi({ fetchImpl, timeoutMs = 15000 } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new TypeError("fetchImpl must be a fetch-compatible function");

  async function request(path, init) {
    const method = init.method || "GET";
    const controller = new AbortController();
    // Race the fetch against the abort signal instead of trusting fetchImpl to reject on
    // abort — an implementation that ignores the signal would otherwise hang past timeoutMs.
    const onTimeout = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new DesignApiError(method + " " + path + " timed out after " + timeoutMs + "ms", { status: 0 }));
      }, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // A pending timeout must not hold a node process open; browsers have no unref.
    if (typeof timer.unref === "function") timer.unref();
    try {
      let response;
      try {
        // Promise.resolve().then(...) so a synchronously-throwing fetchImpl lands in the same
        // catch path as a rejected one.
        response = await Promise.race([
          Promise.resolve().then(() => fetchFn(path, { ...init, signal: controller.signal })),
          onTimeout,
        ]);
      } catch (cause) {
        if (cause instanceof DesignApiError) throw cause;
        throw new DesignApiError(method + " " + path + " failed: " + causeMessage(cause), { status: 0, cause });
      }
      const text = await response.text();
      if (!response.ok) {
        // 404 from the proxy means the sidecar forward isn't wired — "unavailable" is the
        // flavor the panel keys on to show its offline state instead of an error dump.
        const flavor = response.status === 404 ? "unavailable" : "failed";
        const detail = text ? ": " + text.slice(0, BODY_LIMIT) : "";
        throw new DesignApiError(
          method + " " + path + " " + flavor + " (HTTP " + response.status + ")" + detail,
          { status: response.status, body: text },
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DesignApiError(
          method + " " + path + " returned invalid JSON (HTTP " + response.status + ")",
          { status: response.status, body: text },
        );
      }
      // The sidecar reports domain failures as HTTP 200 + { ok: false, error }.
      if (parsed && typeof parsed === "object" && parsed.ok === false) {
        throw new DesignApiError(String(parsed.error ?? method + " " + path + " failed"), {
          status: response.status,
          body: text,
        });
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  const post = (path, body) => request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Validation runs synchronously (plain arrows, not async) so caller misuse throws at the
  // call site instead of surfacing as a stray rejected promise.
  return Object.freeze({
    state: () => request("/api/state", { method: "GET", cache: "no-store" }),
    save: (name, content) => post("/api/save", {
      name: nonEmptyString(name, "name"),
      content: stringValue(content, "content"),
    }),
    docCreate: (title, kind) => post("/api/doc-create", {
      title: nonEmptyString(title, "title"),
      kind: nonEmptyString(kind, "kind"),
    }),
    docDelete: (name) => post("/api/doc-delete", { name: nonEmptyString(name, "name") }),
    editPlace: (op, place) => post("/api/edit-place", { op: nonEmptyString(op, "op"), place }),
    packs: () => request("/api/packs", { method: "GET", cache: "no-store" }),
    catalog: () => request("/api/catalog", { method: "GET", cache: "no-store" }),
    packImport: (dir) => post("/api/pack-import", { pack: stringValue(dir, "dir") }),
    // CAS map save: the payload is the maps array + active id + the rev the
    // client derives from. A 409 surfaces as a DesignApiError the surface
    // answers by resyncing, never by clobbering. allowShrink opts into the
    // bridge's intentional-erasure path (its circuit breaker otherwise rejects
    // a save that guts a content class — it guards ACCIDENTAL loss only).
    mapSave: (maps, activeMapId, baseRev, { allowShrink = false } = {}) => post("/api/map-save", {
      maps: nonEmptyMapList(maps),
      activeMapId: nonEmptyString(activeMapId, "activeMapId"),
      baseRev,
      ...(allowShrink ? { allowShrink: true } : {}),
    }),
  });
}
