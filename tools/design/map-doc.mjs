// map-doc.mjs — the MapDoc contract: the versioned on-disk shape of a project's maps.json.
// SEAM: this module is the ONE owner of the doc schema + migration-on-read. The design server
// (serve-design.mjs) migrates every load through it, and the Map Studio gate imports it directly
// to prove v1→v2 round-trips — so the server and the gate can never disagree about the shape.
//
// v1 (implicit, no `version` field): { activeMapId, maps:[{ id, name, scope, parent, features,
//   sea?, units? }] } — units was itself a migration-on-read addition (the scale contract).
// v2: adds a top-level `version: 2` and guarantees per-map invariants (units present, features
//   an array, id/name strings). v2 is the substrate the painter slices build on: `rasters.elevation`
//   (S1), `rasters.landmass` (P1), `rasters.biomes` (P2), `stamps` (P3) — each lands as an
//   OPTIONAL field so v2 stays a single version (absent field = layer not authored), with its
//   own migration defaults added here.

export const MAPDOC_VERSION = 2;

export function defaultMap(project) {
  return {
    id: "primary",
    name: (project || "project") + " — Hamlet",
    scope: "site",
    parent: null,
    features: [],
    units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
  };
}

export function defaultMapDoc(project) {
  return { version: MAPDOC_VERSION, activeMapId: "primary", maps: [defaultMap(project)] };
}

/** Migrate a raw parsed maps.json (any version, or garbage) to a valid v2 doc, in place-free
 *  fashion (the input is never mutated). Unknown per-map fields are PRESERVED verbatim — a newer
 *  doc read by an older server must not lose data it doesn't understand. Returns
 *  { doc, migratedFrom } where migratedFrom is 1 for a version-less doc, the doc's own version
 *  otherwise (migratedFrom === MAPDOC_VERSION means the doc was already current). */
export function migrateMapDoc(raw, project) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.maps) || raw.maps.length === 0) {
    return { doc: defaultMapDoc(project), migratedFrom: 0, repairedIds: 0 };
  }
  const migratedFrom = Number.isInteger(raw.version) ? raw.version : 1;
  const repaired = { n: 0 };
  const maps = raw.maps
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      ...m,
      id: typeof m.id === "string" && m.id ? m.id : "map-" + Math.abs(hashStr(JSON.stringify(m))).toString(36),
      name: typeof m.name === "string" && m.name ? m.name : String(m.id || "map"),
      scope: typeof m.scope === "string" ? m.scope : "site",
      parent: m.parent ?? null,
      features: repairFeatureIds(Array.isArray(m.features) ? m.features : [], repaired),
      units:
        m.units && typeof m.units === "object" && typeof m.units.unitsPerMeter === "number"
          ? m.units
          : { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
    }));
  if (maps.length === 0) return { doc: defaultMapDoc(project), migratedFrom };
  const activeMapId = maps.some((m) => m.id === raw.activeMapId) ? raw.activeMapId : maps[0].id;
  // Unknown TOP-LEVEL fields are preserved verbatim — the vault carries load-bearing markers
  // here (e.g. migrate-north-negz's `"axes":"north-negz"` refuse-to-run-twice guard; dropping
  // it would let the z-migration re-run and MIRROR the map).
  const extras = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== "version" && k !== "activeMapId" && k !== "maps") extras[k] = v;
  }
  return { doc: { version: MAPDOC_VERSION, activeMapId, maps, ...extras }, migratedFrom, repairedIds: repaired.n };
}

/** Feature ids must be unique per map — sessions used to mint colliding ids
 *  (performance.now-string-length seed), and every id-addressed operation (select, delete,
 *  undo, lasso) resolves by FIRST match, so a collision makes editing the new feature destroy
 *  the old one. Repair on read: the first holder keeps the id, later duplicates get a
 *  deterministic `~n` suffix. Both features are kept; the input array is never mutated. */
function repairFeatureIds(features, repaired) {
  const seen = new Set();
  return features.map((f) => {
    if (!f || typeof f !== "object" || typeof f.id !== "string" || !seen.has(f.id)) {
      if (f && typeof f === "object" && typeof f.id === "string") seen.add(f.id);
      return f;
    }
    let id = f.id;
    do { id = id + "~" + ++repaired.n; } while (seen.has(id));
    seen.add(id);
    return { ...f, id };
  });
}

/** Serialize a doc for saving: always stamps the current version so every write upgrades the
 *  file. `extras` carries the top-level unknown fields of the PREVIOUS on-disk doc (the client
 *  only round-trips maps + activeMapId; the server merges the rest back in — see loadMaps). */
export function serializeMapDoc(maps, activeMapId, extras = {}) {
  const clean = Array.isArray(maps) ? maps.filter((m) => m && typeof m === "object") : [];
  const keep = {};
  for (const [k, v] of Object.entries(extras)) {
    if (k !== "version" && k !== "activeMapId" && k !== "maps") keep[k] = v;
  }
  return {
    version: MAPDOC_VERSION,
    activeMapId: activeMapId || (clean[0] && clean[0].id),
    maps: clean,
    ...keep,
  };
}

// Deterministic tiny string hash (fallback map-id minting only — never identity-bearing).
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
