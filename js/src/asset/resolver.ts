// The resolver — plain routing policy over a set of AssetSources (types.ts). It answers ONE question:
// which source should service this request? It does NOT generate, cache, or hit the network — that is
// the cache's job (cache.ts) over whichever source this picks. Keeping routing a pure, side-effect-free
// policy means the durable log's `source` is a deterministic function of the request, not of runtime
// state.
//
// Two routing modes, explicit first:
//   - EXPLICIT: `req.params.source === source.name` pins a backend by name (an agent/skill overriding
//     policy — "use the file source for this one").
//   - MATCH:    otherwise the first route whose `match(req)` is true wins (ordered = priority).
//   - FALLBACK: if nothing matches, the default source (e.g. the procedural blockout) — or a throw if
//     no fallback is configured, so a misrouted request fails loudly rather than silently nulling out.

import type { AssetRequest, AssetSource } from "./types.ts";

/** One ordered routing rule: a human-readable `name`, a `match` predicate over the request, and the
 *  `source` to use when it wins. */
export interface AssetRoute {
  /** Route label (for diagnostics); the SOURCE name is what `params.source` pins against. */
  readonly name: string;
  match(req: AssetRequest): boolean;
  readonly source: AssetSource;
}

/** Picks the AssetSource for a request: explicit `params.source` override → first matching route →
 *  fallback. Pure policy; resolve() returns a source, it never generates. */
export class AssetResolver {
  private readonly routes: AssetRoute[];
  private readonly fallback?: AssetSource;

  constructor(routes: AssetRoute[] = [], fallback?: AssetSource) {
    this.routes = [...routes];
    this.fallback = fallback;
  }

  /** Append a route (lowest priority). Returns `this` for chaining. */
  add(route: AssetRoute): this {
    this.routes.push(route);
    return this;
  }

  /** Resolve the source for `req`. Throws if an explicit `params.source` names no known source, or if
   *  no route matches and no fallback is configured. */
  resolve(req: AssetRequest): AssetSource {
    const pinned = req.params?.source;
    if (typeof pinned === "string") {
      const hit = this.routes.find((r) => r.source.name === pinned);
      if (hit) return hit.source;
      if (this.fallback?.name === pinned) return this.fallback;
      throw new Error(`AssetResolver: params.source '${pinned}' names no registered source`);
    }
    for (const r of this.routes) if (r.match(req)) return r.source;
    if (this.fallback) return this.fallback;
    throw new Error(`AssetResolver: no route matched (${req.kind}) and no fallback configured`);
  }
}
