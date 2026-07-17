/** Canonical authored terrain.paint albedos. Kept independent from the renderer/PBR modules so
 * both sides of that intentional adapter cycle can consume the data without initialization order. */
export const TERRAIN_PAINT_ALBEDO_HEX = Object.freeze([
  null,       // 0 = unpainted
  0xc4b68e,   // 1 sand
  0x5f7f3c,   // 2 grass
  0x756657,   // 3 rock
  0x6f5334,   // 4 dirt
  0xe2e7ec,   // 5 snow
  0x49512e,   // 6 murk
  0x87927a,   // 7 tundra
] as const);
