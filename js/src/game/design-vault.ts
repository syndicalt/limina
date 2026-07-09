// DESIGN VAULT -> limina instructions. The design space is a Notion/Obsidian-like
// vault of readable, linked markdown documents (concept, art-direction, world-bible,
// cast, storyboard). Those documents are the SOURCE OF TRUTH; this module is the
// TRANSLATOR that turns them into the canonical design.* artifacts, which then compile
// (compileDesignToGds -> world-compile) into a runnable limina world.
//
// The vault stays human-first: authors write natural field names (note, at, home,
// region, meadow, civic) and prose. The translator maps that readable vocabulary onto
// the formal schemas' required fields + closed enums (description, locationId, regionId,
// role, grassland, settlement). Field mapping IS the translation.
//
// Only the YAML frontmatter block of each doc is machine-read; the prose below it is for
// humans. The runtime has no YAML library, so this parses the small, well-defined subset
// the vault docs use (scalars, inline [lists], block lists of scalars, block lists of
// maps, and nested maps) and errors loudly on anything outside it rather than guessing.

import {
  createDesignArtifactStore,
  canonicalizeDesignArtifact,
  type DesignArtifactStore,
  type DesignArtifactKind,
} from "../world/design-artifacts.ts";

// ---- frontmatter parser (targeted YAML subset) ----------------------------

type Frontmatter = Record<string, unknown>;

interface Line {
  indent: number;
  text: string;
}

/** Strip a trailing ` # comment`, but never a `#` inside a quoted scalar (e.g. "#5b4636"). */
function stripInlineComment(raw: string): string {
  const s = raw.trimEnd();
  if (s.startsWith('"') || s.startsWith("'")) return s; // quoted scalar: leave as-is
  const hash = s.indexOf(" #");
  return hash >= 0 ? s.slice(0, hash).trimEnd() : s;
}

function parseScalar(raw: string): unknown {
  let v = raw.trim();
  if (v.length === 0) return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  // inline array: [a, b, c]
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((p) => parseScalar(p.trim()));
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Recursive-descent over indentation. `lines[i..]` at exactly `indent` form one block;
 *  a block is a LIST (its lines start with "- ") or a MAP (its lines are "key: ..."). */
function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  let i = start;
  const isList = i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ");
  if (isList) {
    const arr: unknown[] = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
      const itemText = lines[i].text.slice(2).trim();
      const colon = keyColon(itemText);
      if (colon === -1) {
        arr.push(parseScalar(itemText)); // "- scalar"
        i += 1;
      } else {
        // "- key: val" begins a map object; following deeper lines add fields.
        const obj: Record<string, unknown> = {};
        addMapEntry(obj, itemText);
        i += 1;
        const childIndent = indent + 2;
        while (i < lines.length && lines[i].indent >= childIndent) {
          if (lines[i].indent === childIndent && keyColon(lines[i].text) !== -1) {
            const [k, inlineVal, hasInline] = splitKey(lines[i].text);
            if (hasInline) { obj[k] = parseScalar(inlineVal); i += 1; }
            else { const [child, ni] = parseBlock(lines, i + 1, childIndent + 2); obj[k] = child; i = ni; }
          } else {
            break;
          }
        }
        arr.push(obj);
      }
    }
    return [arr, i];
  }
  // MAP block
  const obj: Record<string, unknown> = {};
  while (i < lines.length && lines[i].indent === indent && keyColon(lines[i].text) !== -1) {
    const [k, inlineVal, hasInline] = splitKey(lines[i].text);
    if (hasInline) { obj[k] = parseScalar(inlineVal); i += 1; }
    else { const [child, ni] = parseBlock(lines, i + 1, indent + 2); obj[k] = child; i = ni; }
  }
  return [obj, i];
}

/** Index of the key/value colon (`key: value`), or -1 if the line is not a map entry. */
function keyColon(text: string): number {
  const m = text.match(/^[A-Za-z0-9_-]+:(\s|$)/);
  return m ? text.indexOf(":") : -1;
}

function splitKey(text: string): [string, string, boolean] {
  const c = text.indexOf(":");
  const key = text.slice(0, c).trim();
  const rest = stripInlineComment(text.slice(c + 1)).trim();
  return [key, rest, rest.length > 0];
}

function addMapEntry(obj: Record<string, unknown>, text: string): void {
  const [k, v, has] = splitKey(text);
  obj[k] = has ? parseScalar(v) : {};
}

export function parseFrontmatter(content: string): Frontmatter {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error("design-vault: document has no YAML frontmatter block");
  const rows: Line[] = m[1]
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0 && !l.trimStart().startsWith("#"))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  const [obj] = parseBlock(rows, 0, 0);
  return obj as Frontmatter;
}

// ---- frontmatter serializer (for structured authoring: add/edit markers etc.) ----

function needsQuote(s: string): boolean {
  return s.length === 0 || /^[\s[\]{}"'#>|*&!%@`-]/.test(s) || /:\s/.test(s) || /\s#/.test(s) || /[:#]$/.test(s);
}
function serScalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(serScalar).join(", ") + "]";
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}
function isPlainObj(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === "[object Object]";
}
function arrayOfMaps(v: unknown[]): boolean {
  return v.length > 0 && v.every(isPlainObj);
}

/** Serialize a plain object back into the YAML subset parseFrontmatter reads. Scalars,
 *  inline scalar arrays ([a, b]), block lists of maps (- key: val), and nested maps. */
export function serializeFrontmatter(obj: Record<string, unknown>, indent = 0): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && arrayOfMaps(v)) {
      lines.push(`${pad}${k}:`);
      for (const item of v as Record<string, unknown>[]) {
        const entries = Object.entries(item).filter(([, iv]) => iv !== undefined);
        entries.forEach(([ik, iv], idx) => {
          const prefix = idx === 0 ? `${pad}  - ` : `${pad}    `;
          if (isPlainObj(iv)) { lines.push(`${prefix}${ik}:`); lines.push(serializeFrontmatter(iv, indent + 6)); }
          else lines.push(`${prefix}${ik}: ${serScalar(iv)}`);
        });
      }
    } else if (Array.isArray(v)) {
      lines.push(`${pad}${k}: ${serScalar(v)}`);
    } else if (isPlainObj(v)) {
      lines.push(`${pad}${k}:`);
      lines.push(serializeFrontmatter(v, indent + 2));
    } else {
      lines.push(`${pad}${k}: ${serScalar(v)}`);
    }
  }
  return lines.join("\n");
}

/** Replace a doc's frontmatter with a serialized object, keeping the prose body verbatim. */
export function replaceFrontmatter(content: string, obj: Record<string, unknown>): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return "---\n" + serializeFrontmatter(obj) + "\n---\n" + body;
}

// ---- readable vocabulary -> schema enums ----------------------------------

const BIOME_MAP: Record<string, string> = {
  meadow: "grassland", grassland: "grassland", forest: "temperate-forest",
  "temperate-forest": "temperate-forest", woods: "temperate-forest", blighted: "blighted",
  blight: "blighted", marsh: "marsh", mountain: "mountain", coast: "coast",
  tundra: "tundra", desert: "desert",
};
// World-bible location kinds are PLACE types; the vault's building types (civic/dwelling/
// religious/military/marker) are finer. Map to the nearest place enum and preserve the
// original building type at the head of the description so the build agent keeps it.
const KIND_MAP: Record<string, string> = {
  civic: "settlement", dwelling: "settlement", settlement: "settlement",
  religious: "landmark", military: "landmark", landmark: "landmark",
  marker: "camp", camp: "camp", ruin: "ruin", dungeon: "dungeon", wild: "wild",
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v);
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ---- per-artifact builders (readable frontmatter -> canonical shape) -------

function buildWorldBible(fm: Frontmatter): unknown {
  const setting = (fm.setting ?? {}) as Record<string, unknown>;
  const zone = (fm.zone ?? {}) as Record<string, unknown>;
  const regions = arr(fm.regions).map((r) => ({
    id: str(r.id),
    name: str(r.name),
    biome: BIOME_MAP[str(r.biome)] ?? "grassland",
    description: str(r.note ?? r.description, str(r.name)),
  }));
  const locations = arr(fm.locations).map((l) => {
    const origKind = str(l.kind);
    const note = str(l.note ?? l.description, str(l.name));
    const pos = Array.isArray(l.position) ? (l.position as number[]) : undefined;
    const loc: Record<string, unknown> = {
      id: str(l.id),
      name: str(l.name),
      regionId: str(l.region ?? l.regionId),
      kind: KIND_MAP[origKind] ?? "landmark",
      description: origKind.length > 0 ? `${origKind}: ${note}` : note,
    };
    if (pos && pos.length >= 2) loc.position = [Number(pos[0]), Number(pos[1])];
    return loc;
  });
  const size = typeof zone.size_m === "number" ? zone.size_m : undefined;
  const bible: Record<string, unknown> = {
    version: "world-bible/1",
    setting: {
      name: str(setting.name, "Untitled"),
      era: str(setting.era, "Unspecified"),
      premise: str(setting.premise, str(fm.setting, "Unspecified")),
    },
    regions,
    locations,
  };
  if (size !== undefined) bible.map = { width: size, height: size };
  return bible;
}

// ---- places (Design Space "Places") ---------------------------------------
// A dedicated `kind: places` vault doc carries a flat `places:` array — the world's
// containment hierarchy (nation > province > settlement > landmark), each node linked to
// its parent by `parentId` (root nodes have none). A node is PLACED when it carries a
// `position` [x,z] and UNPLACED otherwise (authored but not yet sited). This is a READ-ONLY
// translation for the UI (Stage 1): places do not (yet) compile into the GDS, so — like the
// readable world-bible `locations:` the map reads — they are parsed straight from the doc's
// frontmatter rather than entering the design.* artifact store. The UI builds the nested tree
// from this flat list by `parentId`.

export interface PlaceNode {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
  position?: [number, number];
  binding?: string;
  radiusM?: number;
  regionId?: string;
  map?: string;
  tags?: string[];
  note?: string;
  /** The catalog asset this place is MARKED by — its map glyph and the worldmap anchor it spawns at
   *  compile. Folds the retired world-bible location's asset/anchor role into a place. */
  assetId?: string;
  /** A nested child-map id this place links to (double-click on the map to zoom in) — same meaning
   *  as the old location `mapLink`. */
  mapLink?: string;
}

/** Parse the flat `places:` array of a `kind: places` doc into normalized place nodes.
 *  Mirrors buildWorldBible's location parse: readable field names, position -> placed. */
export function parsePlaces(fm: Frontmatter): PlaceNode[] {
  return arr(fm.places)
    .map((p) => {
      const pos = Array.isArray(p.position) ? (p.position as number[]) : undefined;
      const parent = str(p.parentId);
      const node: PlaceNode = {
        id: str(p.id),
        name: str(p.name, str(p.id)),
        kind: str(p.kind, "place"),
        parentId: parent.length > 0 ? parent : null,
      };
      if (pos && pos.length >= 2) node.position = [Number(pos[0]), Number(pos[1])];
      const binding = str(p.binding);
      if (binding.length > 0) node.binding = binding;
      if (typeof p.radiusM === "number") node.radiusM = p.radiusM;
      const region = str(p.regionId ?? p.region);
      if (region.length > 0) node.regionId = region;
      const map = str(p.map);
      if (map.length > 0) node.map = map;
      if (Array.isArray(p.tags)) node.tags = (p.tags as unknown[]).map((t) => str(t));
      const note = str(p.note ?? p.description);
      if (note.length > 0) node.note = note;
      const asset = str(p.assetId);
      if (asset.length > 0) node.assetId = asset;
      const link = str(p.mapLink);
      if (link.length > 0) node.mapLink = link;
      return node;
    })
    .filter((n) => n.id.length > 0);
}

function castRole(m: Record<string, unknown>): string {
  return str(m.role ?? m.note ?? m.behavior, "resident");
}

function buildCast(fm: Frontmatter): unknown {
  const p = (fm.player ?? {}) as Record<string, unknown>;
  const player = {
    id: str(p.id, "player"),
    name: str(p.name, "Player"),
    archetype: str(p.archetype ?? p.asset, "villager"),
    ...(p.asset ? { brief: { asset: str(p.asset) } } : {}),
  };
  // NPCs + creatures both become cast npcs (Cast = player + npcs). Creatures carry their
  // nature in the role string; this cut has no combat, so they are ambient bodies.
  const npcs = [...arr(fm.npcs), ...arr(fm.creatures)].map((n) => {
    const npc: Record<string, unknown> = {
      id: str(n.id),
      name: str(n.name),
      archetype: str(n.archetype ?? n.asset, "villager"),
      role: castRole(n),
    };
    const loc = str(n.home ?? n.locationId);
    if (loc.length > 0) npc.locationId = loc;
    if (n.asset) npc.brief = { asset: str(n.asset) };
    return npc;
  });
  return { version: "cast/1", player, npcs };
}

function buildStoryboard(fm: Frontmatter): unknown {
  const beats = arr(fm.beats).map((b) => {
    const beat: Record<string, unknown> = {
      id: str(b.id),
      title: str(b.name ?? b.title),
      description: str(b.note ?? b.description, str(b.name ?? b.title)),
    };
    const at = str(b.at ?? b.locationId);
    if (at.length > 0) beat.locationId = at;
    return beat;
  });
  return { version: "storyboard/1", beats, quests: [] };
}

/** Pick a target location (id, name, [x,z]) for the synthesized "reach" DoD: prefer a
 *  storyboard beat whose location has a position in the world bible, else the first
 *  positioned location. Returns undefined if the world has no positioned location. */
function reachTarget(
  world: Frontmatter,
  storyboard: Frontmatter,
): { name: string; x: number; z: number } | undefined {
  const locs = arr(world.locations).filter((l) => Array.isArray(l.position));
  const posOf = (l: Record<string, unknown>) => l.position as number[];
  for (const b of arr(storyboard.beats)) {
    const at = str(b.at ?? b.locationId);
    const hit = locs.find((l) => str(l.id) === at);
    if (hit) return { name: str(hit.name), x: Number(posOf(hit)[0]), z: Number(posOf(hit)[1]) };
  }
  const first = locs[0];
  return first ? { name: str(first.name), x: Number(posOf(first)[0]), z: Number(posOf(first)[1]) } : undefined;
}

/** Synthesize a valid GDS base from the concept doc + the cast's player + the world/beats.
 *  Build-config fields (controls, platforms, scope, optIn, win/lose) get sensible
 *  exploration defaults so the concept doc stays readable design prose, not config. The GDS
 *  requires one automated (state-transition) DoD, so exploration synthesizes a "reach"
 *  drive toward a real location the storyboard visits. */
function buildGds(concept: Frontmatter, cast: Frontmatter, storyboard: Frontmatter, world: Frontmatter): unknown {
  const player = (cast.player ?? {}) as Record<string, unknown>;
  const target = reachTarget(world, storyboard);
  const xz = target ? `${target.x},${target.z}` : "0,0";
  const dodStatement = target
    ? `The player can walk from spawn and reach ${target.name}.`
    : "The player can walk and explore the world.";
  return {
    id: str(concept.id, "game"),
    pitch: str(concept.logline, str(concept.title, "A game")),
    loopSentence: str(concept.loop, "Explore the world."),
    controls: {
      scheme: "keyboard-mouse",
      intents: [{ name: "walk", binding: "WASD", description: "Move the character on foot" }],
    },
    winCondition: "Open exploration — no explicit win condition in this cut.",
    loseCondition: "No fail state in this cut.",
    artDirection: str(concept.title, "the project") + " — see art-direction.md (grounded stylized realism).",
    targetPlatforms: ["web"],
    scopeTier: "prototype",
    optIn: "record+export",
    entities: [{
      id: str(player.id, "player"),
      name: str(player.name, "Player"),
      role: "player",
      states: [],
    }],
    dod: [{
      id: "dod-reach-overlook",
      statement: dodStatement,
      kind: "state-transition",
      drives: {
        description: "Walk from spawn toward the target location and arrive.",
        steps: [{ toward: `walkToward:${xz}`, forward: 1, repeat: 240, until: "reached" }],
        assert: [{ check: "playerReachedXZ", target: xz }],
      },
    }],
  };
}

// ---- build links -----------------------------------------------------------

/** A doc entity's forward reference into the build. `buildId` is resolved after compile
 *  (the placement / entity id it produced); before that it reads `unbuilt` in the doc. */
export interface BuildLink {
  doc: DesignArtifactKind;
  entity: string;   // the id in the doc (location id, cast id)
  name: string;
  buildId: string | null;
}

// ---- mind-map graph (generated from the docs' relationships) ---------------

export interface GraphNode { id: string; label: string; type: string; }
export interface GraphEdge { from: string; to: string; label: string; }
export interface VaultGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

/** Build the mind-map graph from the vault's own relationships: regions, locations,
 *  cast, and beats become nodes; the typed references between them (location in region,
 *  npc lives-in location, beat occurs-at location, creature emerges-from region) become
 *  edges. This is both the design graph and the cascade/impact graph. */
export function vaultGraph(docs: VaultDoc[]): VaultGraph {
  const byKind = new Map<string, Frontmatter>();
  for (const d of docs) {
    try { byKind.set(str(parseFrontmatter(d.content).kind), parseFrontmatter(d.content)); } catch { /* skip */ }
  }
  const world = byKind.get("world-bible") ?? {};
  const cast = byKind.get("cast") ?? {};
  const story = byKind.get("storyboard") ?? {};
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string, type: string) => {
    if (id.length === 0 || seen.has(id)) return;
    seen.add(id); nodes.push({ id, label, type });
  };
  for (const r of arr(world.regions)) add(str(r.id), str(r.name), "region");
  for (const l of arr(world.locations)) {
    add(str(l.id), str(l.name), "location");
    const reg = str(l.region ?? l.regionId);
    if (reg) edges.push({ from: str(l.id), to: reg, label: "in" });
  }
  const p = (cast.player ?? {}) as Record<string, unknown>;
  if (p.id) add(str(p.id), str(p.name), "player");
  for (const n of arr(cast.npcs)) {
    add(str(n.id), str(n.name), "npc");
    const h = str(n.home ?? n.locationId);
    if (h) edges.push({ from: str(n.id), to: h, label: "lives-in" });
  }
  for (const c of arr(cast.creatures)) {
    add(str(c.id), str(c.name), "creature");
    const h = str(c.home ?? c.locationId);
    if (h) edges.push({ from: str(c.id), to: h, label: "emerges-from" });
  }
  for (const b of arr(story.beats)) {
    add(str(b.id), str(b.name ?? b.title), "beat");
    const at = str(b.at ?? b.locationId);
    if (at) edges.push({ from: str(b.id), to: at, label: "occurs-at" });
  }
  // keep only edges whose endpoints both exist
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

// ---- entity diff (what changed on save, to drive the cascade) --------------

/** Every id-bearing design entity in a single doc (locations, regions, cast, beats),
 *  each with a signature of its content so a MODIFY can be told from a no-op. */
export function docEntities(content: string): { id: string; sig: string }[] {
  let fm: Frontmatter;
  try { fm = parseFrontmatter(content); } catch { return []; }
  const out: { id: string; sig: string }[] = [];
  // Cartography-only fields (map assignment + child-map link) are NOT part of the design
  // signature: changing which map a marker sits on, or unlinking it, must not cascade.
  const push = (v: Record<string, unknown>) => {
    const id = str(v.id);
    if (!id) return;
    const { map: _m, mapLink: _l, ...rest } = v;
    out.push({ id, sig: JSON.stringify(rest) });
  };
  for (const l of arr(fm.locations)) push(l);
  for (const r of arr(fm.regions)) push(r);
  const p = fm.player as Record<string, unknown> | undefined;
  if (p && p.id) push(p);
  for (const n of arr(fm.npcs)) push(n);
  for (const c of arr(fm.creatures)) push(c);
  for (const b of arr(fm.beats)) push(b);
  return out;
}

/** Diff a doc's entities before vs after an edit -> the changes that drive cascade impact. */
export function diffDocEntities(oldContent: string, newContent: string): { entityId: string; op: "added" | "modified" | "removed" }[] {
  const oldMap = new Map(docEntities(oldContent).map((e) => [e.id, e.sig]));
  const newMap = new Map(docEntities(newContent).map((e) => [e.id, e.sig]));
  const changes: { entityId: string; op: "added" | "modified" | "removed" }[] = [];
  for (const [id, sig] of newMap) {
    if (!oldMap.has(id)) changes.push({ entityId: id, op: "added" });
    else if (oldMap.get(id) !== sig) changes.push({ entityId: id, op: "modified" });
  }
  for (const id of oldMap.keys()) if (!newMap.has(id)) changes.push({ entityId: id, op: "removed" });
  return changes;
}

// ---- top-level: vault -> design store --------------------------------------

export interface VaultDoc { name: string; content: string; }

export interface VaultTranslation {
  store: DesignArtifactStore;
  links: BuildLink[];
  kinds: DesignArtifactKind[];
}

/** Parse a vault (the design/*.md docs) into a validated design.* store, plus the set of
 *  build-link stubs (locations + cast members) whose buildId compile will fill in. */
export function vaultToStore(docs: VaultDoc[]): VaultTranslation {
  const byKind = new Map<string, Frontmatter>();
  for (const doc of docs) {
    const fm = parseFrontmatter(doc.content);
    const kind = str(fm.kind);
    if (kind.length === 0) throw new Error(`design-vault: ${doc.name} frontmatter has no 'kind'`);
    byKind.set(kind, fm);
  }
  const concept = byKind.get("concept");
  if (concept === undefined) throw new Error("design-vault: no concept document (kind: concept)");
  const castFm = byKind.get("cast") ?? { player: {}, npcs: [] };
  const storyFm = byKind.get("storyboard") ?? { beats: [] };
  const worldFm = byKind.get("world-bible") ?? { locations: [] };

  const store = createDesignArtifactStore();
  const kinds: DesignArtifactKind[] = [];
  const set = (kind: DesignArtifactKind, value: unknown) => {
    store.artifacts.set(kind, canonicalizeDesignArtifact(kind, value));
    kinds.push(kind);
  };

  set("gds", buildGds(concept, castFm, storyFm, worldFm));
  if (byKind.has("world-bible")) set("worldBible", buildWorldBible(byKind.get("world-bible")!));
  if (byKind.has("cast")) set("cast", buildCast(castFm));
  if (byKind.has("storyboard")) set("storyboard", buildStoryboard(storyFm));

  // Build-link stubs: every location + cast member the design references. compile resolves
  // buildId from the placements it produces (location-<id> / entity-<id>).
  const links: BuildLink[] = [];
  const bibleFm = byKind.get("world-bible");
  if (bibleFm) for (const l of arr(bibleFm.locations)) {
    links.push({ doc: "worldBible", entity: str(l.id), name: str(l.name), buildId: null });
  }
  for (const n of [...arr(castFm.npcs), ...arr(castFm.creatures)]) {
    links.push({ doc: "cast", entity: str(n.id), name: str(n.name), buildId: null });
  }
  const p = (castFm.player ?? {}) as Record<string, unknown>;
  if (p.id) links.push({ doc: "cast", entity: str(p.id), name: str(p.name), buildId: null });

  return { store, links, kinds };
}
