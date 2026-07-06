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
