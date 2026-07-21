import { sha256 } from "../src/world/sha256.mjs";
import { SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_TILE_SCHEMA } from "../src/world/surface-composite-tile.mjs";
import { decodeSurfaceCompositeArtifact, encodeSurfaceCompositeArtifact, inspectSurfaceCompositeArtifactBindings } from "../src/world/compiler/surface-composite-artifact.mjs";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_surface_composite_artifact FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string) { let error: unknown; try { fn(); } catch (caught) { error = caught; } assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`); }
const hash = (data: Uint8Array) => `sha256:${sha256(data)}`;
const total = 258, pixels = total * total;
function map(kind: "albedo" | "normal" | "orm") { const data = new Uint8Array(pixels * 4); for (let i = 0; i < pixels; i++) { const x = i % total, y = Math.floor(i / total), o = i * 4;
  if (kind === "albedo") { data[o] = 52 + (x >> 4); data[o + 1] = 83 + (y >> 4); data[o + 2] = 39; }
  else if (kind === "normal") { data[o] = 128 + ((x + y) % 3) - 1; data[o + 1] = 128; data[o + 2] = 255; }
  else { data[o] = 235; data[o + 1] = 181 + ((x >> 5) & 3); data[o + 2] = 0; }
  data[o + 3] = 255; } return data; }
const albedo = map("albedo"), normal = map("normal"), orm = map("orm");
const edge = hash(new Uint8Array([1, 2, 3]));
const artifact = { schema: SURFACE_COMPOSITE_TILE_SCHEMA,
  source: { biomeFieldHash: hash(new Uint8Array([4])), biomePackHash: hash(new Uint8Array([5])), terrainChunkHash: hash(new Uint8Array([6])), policyVersion: SURFACE_COMPOSITE_POLICY_VERSION },
  coord: { tx: -7, tz: 9, lod: 0 }, placement: { origin: [-1_000_000, 1_000_000], sizeM: 48, featureOrigin: [-1_000_000, 1_000_000] },
  resolution: { interior: 256, gutter: 1, total },
  maps: { albedo: { data: albedo, contentHash: hash(albedo), colorSpace: "srgb" }, normal: { data: normal, contentHash: hash(normal), colorSpace: "none", convention: "opengl-y-plus" }, orm: { data: orm, contentHash: hash(orm), colorSpace: "none", channels: "ao-roughness-metalness-grass-density" } },
  edgeHashes: { north: edge, east: edge, south: edge, west: edge }, diagnostics: { roles: 16, runtimeTextureSamples: 3, outputBytes: pixels * 4 * 3 } };

const first = encodeSurfaceCompositeArtifact(artifact), second = encodeSurfaceCompositeArtifact(artifact);
assert(first.length === second.length && first.every((byte, index) => byte === second[index]), "encoding is not byte deterministic");
assert(first.length < artifact.diagnostics.outputBytes / 3, `representative composite did not compress materially (${first.length} bytes)`);
const decoded = decodeSurfaceCompositeArtifact(first);
for (const name of ["albedo", "normal", "orm"] as const) assert(decoded.maps[name].data.every((byte: number, index: number) => byte === artifact.maps[name].data[index]), `${name} round-trip changed pixels`);
assert(decoded.coord.tx === -7 && decoded.placement.origin[0] === -1_000_000 && decoded.diagnostics.runtimeTextureSamples === 3, "bindings did not round-trip");
const bindings = inspectSurfaceCompositeArtifactBindings(first);
assert(bindings.source.terrainChunkHash === artifact.source.terrainChunkHash && !(bindings.maps.albedo as any).data, "inspection leaked pixels or lost cross-binding");
const truncated = first.slice(0, -1); rejects(() => decodeSurfaceCompositeArtifact(truncated), /header|length|truncated|invalid/, "truncation was accepted");
const trailing = new Uint8Array(first.length + 1); trailing.set(first); rejects(() => decodeSurfaceCompositeArtifact(trailing), /header|length|trailing|invalid/, "trailing byte was accepted");
const mutated = first.slice(); mutated[mutated.length - 4] ^= 1; rejects(() => decodeSurfaceCompositeArtifact(mutated), /hash mismatch|truncated|exceeds/, "payload mutation was accepted");
const badHash = { ...artifact, maps: { ...artifact.maps, albedo: { ...artifact.maps.albedo, contentHash: artifact.source.biomeFieldHash } } };
rejects(() => encodeSurfaceCompositeArtifact(badHash), /content hash mismatch/, "lying map hash was accepted");
rejects(() => encodeSurfaceCompositeArtifact(artifact, { shouldCancel: () => true }), /cancelled/, "encode cancellation was ignored");
rejects(() => decodeSurfaceCompositeArtifact(first, { shouldCancel: () => true }), /cancelled/, "decode cancellation was ignored");
console.log(`p_surface_composite_artifact OK: deterministic lossless QOI envelope ${first.length}B from ${artifact.diagnostics.outputBytes}B, strict bindings/tamper/cancellation`);
