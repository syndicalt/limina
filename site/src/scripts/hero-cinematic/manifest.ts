// Shared asset manifest + per-phase scene data for the hero cinematic.
// Pure data — imported by both the Node fetch script (scripts/fetch-hero-assets.mjs)
// and the runtime modules. Real CC0 assets (character, ambient creatures, HDRIs)
// are downloaded live; genre dressing is procedural (see DRESSING) to stay reliable,
// low-payload, 60fps, and on-brand with Limina's stylised low-poly aesthetic.

export type PhaseId = 'builder' | 'fantasy' | 'western' | 'scifi' | 'sim';

/** Objects on this render layer are selectively bloomed by postfx. */
export const BLOOM_LAYER = 1;

export interface AssetEntry {
  key: string;
  url: string;
  fallbackUrl?: string;
  license: 'CC0';
  credit: string;
}

// three.js RobotExpressive — CC0 (Tomás Laulhé, modified by Don McCurdy).
// Clip set includes Idle / Walking / Running / Dance / Death / ... (standard).
export const CHARACTER: AssetEntry = {
  key: 'robot',
  url: 'https://raw.githubusercontent.com/mrdoob/three.js/r184/examples/models/gltf/RobotExpressive/RobotExpressive.glb',
  fallbackUrl:
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/models/gltf/RobotExpressive/RobotExpressive.glb',
  license: 'CC0',
  credit: 'RobotExpressive by Tomás Laulhé (CC0), modified by Don McCurdy — via three.js examples',
};

// Small CC0 creature GLBs (Quaternius) used as ambient "agent life" in worlds.
export const CREATURES: AssetEntry[] = [
  {
    key: 'deer',
    url: 'https://raw.githubusercontent.com/Quaternius/TestGltfAssets/master/Deer/Deer.glb',
    license: 'CC0',
    credit: 'Deer by Quaternius (CC0)',
  },
  {
    key: 'slime',
    url: 'https://raw.githubusercontent.com/Quaternius/TestGltfAssets/master/Slime/Slime.glb',
    license: 'CC0',
    credit: 'Slime by Quaternius (CC0)',
  },
];

// Poly Haven HDRIs (CC0). Fetched at 1k .hdr via api.polyhaven.com → dl.polyhaven.org.
// Each entry resolves at build time; on 404 the script tries `fallback`.
export const HDRIS: { phase: PhaseId; slug: string; fallback: string }[] = [
  { phase: 'builder', slug: 'studio_small_03', fallback: 'studio_small_08' },
  { phase: 'fantasy', slug: 'kloofendal_48d_partly_cloudy_puresky', fallback: 'qwantani_puresky' },
  { phase: 'western', slug: 'qwantani_dusk_2_puresky', fallback: 'qwantani_dusk_2' },
  { phase: 'scifi', slug: 'dikhololo_night', fallback: 'moonless_golf' },
  { phase: 'sim', slug: 'kloofendal_48d_partly_cloudy', fallback: 'spruit_sunrise' },
];

// ---------------------------------------------------------------------------
// Per-phase visual config. `pathU` is the portion of the run curve; `t` the
// seconds window inside the 28s loop. Consumed by world.ts (env/fog/ground/
// lighting), timeline.ts (windows + grade), portals.ts (boundaries).
// ---------------------------------------------------------------------------
export interface PhaseConfig {
  id: PhaseId;
  pathU: [number, number];
  t: [number, number];
  /** Use the phase HDRI as the visible background, else a flat color. */
  bg: 'hdri' | number;
  fog: { color: number; density: number };
  /** Ground material, or null for the builder grid. */
  ground: { color: number; metalness: number; roughness: number } | null;
  /** Filmic grade (per-channel lift/gamma/gain applied in postfx). */
  grade: { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number] };
}

export const PHASES: PhaseConfig[] = [
  {
    id: 'builder',
    pathU: [0.0, 0.2],
    t: [0, 4],
    bg: 0x070912,
    fog: { color: 0x070912, density: 0.05 },
    ground: null,
    grade: { lift: [0.0, 0.01, 0.03], gamma: [1.0, 1.0, 1.02], gain: [0.95, 1.0, 1.08] },
  },
  {
    id: 'fantasy',
    pathU: [0.2, 0.4],
    t: [4, 9],
    bg: 'hdri',
    fog: { color: 0x9ec0d8, density: 0.018 },
    ground: { color: 0x2f4a2a, metalness: 0.0, roughness: 0.95 },
    grade: { lift: [0.0, 0.02, 0.0], gamma: [1.02, 1.04, 0.98], gain: [1.02, 1.08, 0.98] },
  },
  {
    id: 'western',
    pathU: [0.4, 0.6],
    t: [9, 14],
    bg: 'hdri',
    fog: { color: 0xd9b888, density: 0.016 },
    ground: { color: 0xc79a5e, metalness: 0.0, roughness: 1.0 },
    grade: { lift: [0.0, -0.01, -0.02], gamma: [1.0, 0.97, 0.9], gain: [1.0, 0.92, 0.76] },
  },
  {
    id: 'scifi',
    pathU: [0.6, 0.8],
    t: [14, 19],
    bg: 0x05060f,
    fog: { color: 0x0a1430, density: 0.03 },
    ground: { color: 0x10131c, metalness: 0.85, roughness: 0.25 },
    grade: { lift: [0.0, 0.01, 0.04], gamma: [0.98, 1.0, 1.06], gain: [0.92, 1.02, 1.18] },
  },
  {
    id: 'sim',
    pathU: [0.8, 1.0],
    t: [19, 24],
    bg: 'hdri',
    fog: { color: 0xcfe0ff, density: 0.022 },
    ground: { color: 0x3f7a44, metalness: 0.0, roughness: 0.9 },
    grade: { lift: [0.01, 0.02, 0.02], gamma: [1.0, 1.02, 1.0], gain: [1.05, 1.08, 1.05] },
  },
];

// Portal boundary positions along the curve (end of each phase). The last is the
// "return" portal that loops back to the builder. Consumed by portals.ts.
export const PORTAL_US = [0.2, 0.4, 0.6, 0.8, 0.985];

// ---------------------------------------------------------------------------
// Procedural dressing tables. world.ts generates each `kind` as stylised
// low-poly geometry and scatters `count` instances along [u0,u1] of the curve,
// offset laterally within `spread` metres, scaled within `scale`.
// ---------------------------------------------------------------------------
export type PropKind =
  | 'pineTree'
  | 'roundTree'
  | 'rock'
  | 'cactus'
  | 'mushroom'
  | 'crystal'
  | 'scifiPillar'
  | 'scifiPanel'
  | 'house'
  | 'fence'
  | 'lamp';

export interface DressRow {
  kind: PropKind;
  count: number;
  along: [number, number]; // sub-range of the phase's pathU
  spread: [number, number]; // min/max lateral offset (each side)
  scale: [number, number];
  /** Pre-pick one instance as a "skill prop" that emits trail sparks when passed. */
  skillProp?: boolean;
}

export const DRESSING: Record<PhaseId, DressRow[]> = {
  builder: [
    // builder is mostly procedural panels/grid (world.ts), plus floating data shards
    { kind: 'crystal', count: 7, along: [0.08, 0.92], spread: [4, 9], scale: [0.4, 0.9], skillProp: true },
  ],
  fantasy: [
    { kind: 'pineTree', count: 12, along: [0.05, 0.96], spread: [9, 17], scale: [1.6, 2.8] },
    { kind: 'roundTree', count: 8, along: [0.05, 0.96], spread: [9, 16], scale: [1.4, 2.2] },
    { kind: 'rock', count: 5, along: [0.05, 0.96], spread: [10, 17], scale: [0.6, 1.6] },
    { kind: 'mushroom', count: 6, along: [0.06, 0.94], spread: [7, 11], scale: [0.5, 1.1], skillProp: true },
  ],
  western: [
    { kind: 'rock', count: 12, along: [0.05, 0.96], spread: [6, 18], scale: [2.0, 5.5] }, // mesas
    { kind: 'cactus', count: 12, along: [0.05, 0.96], spread: [4.5, 13], scale: [1.0, 2.2], skillProp: true },
    { kind: 'fence', count: 6, along: [0.06, 0.94], spread: [2.5, 6], scale: [1.0, 1.4] },
  ],
  scifi: [
    { kind: 'scifiPillar', count: 12, along: [0.05, 0.96], spread: [4, 9], scale: [1.0, 1.8] },
    { kind: 'scifiPanel', count: 10, along: [0.05, 0.96], spread: [4.5, 10], scale: [1.0, 2.2], skillProp: true },
    { kind: 'crystal', count: 8, along: [0.06, 0.94], spread: [4, 8], scale: [0.6, 1.4] },
  ],
  sim: [
    { kind: 'house', count: 8, along: [0.05, 0.96], spread: [5, 10], scale: [1.2, 1.8] },
    { kind: 'roundTree', count: 10, along: [0.05, 0.96], spread: [4, 11], scale: [1.2, 2.0] },
    { kind: 'fence', count: 7, along: [0.06, 0.94], spread: [3, 7], scale: [1.0, 1.3], skillProp: true },
    { kind: 'lamp', count: 6, along: [0.06, 0.94], spread: [4, 7], scale: [1.0, 1.3] },
  ],
};

/** Brand palette (matches site/src/styles/global.css). */
export const BRAND = {
  teal: 0x2fe6d6,
  cyan: 0x3bc9ff,
  violet: 0x8b6bff,
  magenta: 0xff5aa0,
  amber: 0xffb454,
  bg: 0x070912,
} as const;
