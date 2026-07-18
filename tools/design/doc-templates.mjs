// Vault document starter templates. Seam: every kind offered by the Design Space
// "New document" dialog gets frontmatter that SATISFIES its hard consumers — a
// template that parses in the UI but fails the compiler downstream (world-bible
// without zone.size_m broke every 3D peek) is a template bug, not an authoring bug.
//
// Hard consumer contracts:
//   world-bible — js/src/world/design-map-compile.mjs readZoneSizeM requires a
//     `zone:` BLOCK with `size_m:` (the scale contract: authored outlines may span
//     at most 2x size_m per axis; origin center [0,0], north = -z per the axis
//     convention). A scalar `zone: <word>` does not parse.
//   places — js/src/game/design-vault.ts parsePlaces reads `places:` (tolerates
//     absent; the empty list makes the contract visible to the author).
// Every other kind is a free-form linkable note: kind + title suffice.

export const DOC_KINDS = Object.freeze([
  "note", "lore", "faction", "location", "character", "concept",
  "art-direction", "world-bible", "cast", "storyboard",
]);

/** Starter size_m from the active map's paintable rect: outlines live inside the
 *  rect, and the compiler allows 2x size_m per axis, so half the larger rect axis
 *  always passes. No rect yet (nothing painted) -> the scale check cannot trip;
 *  200 matches the design-gate fixtures. */
export function zoneSizeMFromMap(map) {
  const rect = map?.rasters?.landmass?.rect;
  if (rect === undefined) return 200;
  const span = Math.max(Number(rect.w) || 0, Number(rect.h) || 0);
  return span > 0 ? Math.ceil(span / 2) : 200;
}

export function docTemplate(kind, title, { zoneSizeM = 200 } = {}) {
  const k = String(kind || "note");
  const t = String(title || "note");
  const extras = k === "world-bible"
    ? `zone:\n  size_m: ${zoneSizeM}\n  origin: center [0,0]; north = -z\nlocations: []\n`
    : k === "places"
    ? "places: []\n"
    : "";
  return `---\nkind: ${k}\ntitle: ${t}\n${extras}---\n\n# ${t}\n\nWrite here. Link with [[other-doc]].\n`;
}
