// Disposal gate for the imported-material registry: replacing a name must dispose the retired
// recipe's GPU textures exactly once — but never a texture another entry (including the
// replacement) still shares — and registry dispose() must retire every owned texture exactly once,
// clear the map, and aggregate (not swallow) disposal failures. Counter-instrumented textures make
// each property falsifiable: dispose-all, dispose-never, and double-dispose all fail loudly here.

import { MaterialRegistry, type ImportedMaterialSpec, type ImportedTextures } from "../src/materials/material-registry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_material_registry_dispose FAIL: ${message}`);
}

const SPEC: ImportedMaterialSpec = {
  triplanar: false, scale: 1, normalStrength: 1, sharpness: 8,
  metalness: 0, roughness: 0.8, occlusionStrength: 1, antiTiling: false,
};

// The registry's disposal seam touches only object identity and dispose(); counter stubs keep the
// gate headless-exact and every once-only/shared/failure property directly falsifiable.
type RegistryTexture = NonNullable<ImportedTextures["albedo"]>;
const disposals = new Map<string, number>();
function texture(id: string, throws = false): RegistryTexture {
  return {
    name: id,
    dispose(): void {
      disposals.set(id, (disposals.get(id) ?? 0) + 1);
      if (throws) throw new Error(`injected ${id} dispose failure`);
    },
  } as unknown as RegistryTexture;
}
function count(id: string): number {
  return disposals.get(id) ?? 0;
}
function textureSet(overrides: Partial<ImportedTextures>): ImportedTextures {
  return { albedo: null, normal: null, roughness: null, occlusion: null, displacement: null, ...overrides };
}

const registry = new MaterialRegistry();
const shared = texture("shared");
const aOnly = texture("a-only");
const bOnly = texture("b-only");

registry.define("mat-a", SPEC, textureSet({ albedo: shared, normal: aOnly }), { albedo: "sha256:aa" });
registry.define("mat-b", SPEC, textureSet({ albedo: shared, roughness: bOnly }), { albedo: "sha256:aa" });
assert(count("shared") === 0 && count("a-only") === 0 && count("b-only") === 0,
  "fresh definitions disposed textures");

// Replacing mat-a retires a-only (unshared) exactly once, but never the still-shared albedo.
const aSecond = texture("a-second");
registry.define("mat-a", SPEC, textureSet({ albedo: aSecond }), { albedo: "sha256:ab" });
assert(count("a-only") === 1, "replacement did not dispose the retired unshared texture exactly once");
assert(count("shared") === 0, "replacement disposed a texture another entry still shares");
assert(count("a-second") === 0, "replacement disposed the incoming texture");

// A replacement that keeps its own texture (self-shared) must not dispose it.
registry.define("mat-a", { ...SPEC, roughness: 0.5 }, textureSet({ albedo: aSecond }), { albedo: "sha256:ab" });
assert(count("a-second") === 0, "re-defining with the same texture disposed a surviving texture");

// One texture bound in two slots of the retired entry is still disposed exactly once.
const doubled = texture("doubled");
registry.define("mat-c", SPEC, textureSet({ albedo: doubled, occlusion: doubled }), {});
registry.define("mat-c", SPEC, textureSet({}), {});
assert(count("doubled") === 1, "a multi-slot retired texture was not disposed exactly once");

// A throwing retired texture surfaces as AggregateError, and the replacement is still registered.
const faulty = texture("faulty", true);
registry.define("mat-d", SPEC, textureSet({ albedo: faulty }), {});
const beforeFault = registry.contentHashOf("mat-d");
let replaceFailure: unknown;
try {
  registry.define("mat-d", SPEC, textureSet({ albedo: texture("d-second") }), { albedo: "sha256:dd" });
} catch (error) {
  replaceFailure = error;
}
assert(replaceFailure instanceof AggregateError && replaceFailure.errors.length === 1,
  "replacement texture-disposal failure was swallowed or mis-aggregated");
assert(count("faulty") === 1, "throwing retired texture was not attempted exactly once");
assert(registry.has("mat-d") && registry.contentHashOf("mat-d") !== beforeFault,
  "a disposal failure rolled back the already-committed replacement entry");

// Registry-level dispose(): every owned texture exactly once (deduped across entries and slots),
// map cleared, failures aggregated, and a retry never double-disposes.
const failing = texture("failing", true);
registry.define("mat-e", SPEC, textureSet({ normal: failing }), {});
const preDispose = new Map(disposals);
let disposeFailure: unknown;
try {
  registry.dispose();
} catch (error) {
  disposeFailure = error;
}
assert(disposeFailure instanceof AggregateError && disposeFailure.errors.length === 1,
  "registry disposal failure was swallowed or mis-aggregated");
assert(count("shared") === 1 && count("a-second") === 1 && count("b-only") === 1 && count("failing") === 1,
  "registry dispose() did not retire every owned texture exactly once");
assert(count("a-only") === (preDispose.get("a-only") ?? 0) && count("doubled") === (preDispose.get("doubled") ?? 0),
  "registry dispose() re-disposed textures already retired by replacement");
assert(registry.names().length === 0 && !registry.has("mat-a"),
  "registry dispose() did not clear the entry map");
const afterDispose = new Map(disposals);
registry.dispose();
for (const [id, seen] of afterDispose) {
  assert(count(id) === seen, `repeated registry dispose() re-disposed texture "${id}"`);
}

// The registry stays usable for a fresh session definition after dispose().
registry.define("mat-a", SPEC, textureSet({ albedo: texture("post-dispose") }), {});
assert(registry.has("mat-a") && count("post-dispose") === 0, "post-dispose definition was rejected or eagerly disposed");

console.log("p_material_registry_dispose OK: replacement retires unshared textures exactly once, shared textures survive, disposal failures aggregate without rollback or double-dispose, and dispose() clears the registry");
