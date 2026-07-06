// design.* skills -- first-class design artifacts in the unified recorded world log.
//
// Mutations go through SkillRegistry.invoke like every world authoring command, so
// WorldRecorder records design.set/design.patch as ordinary SkillCommands and replay /
// AuthoritativeServer rehydrate rebuild the store by re-invoking them.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";
import {
  DESIGN_ARTIFACT_KINDS,
  canonicalizeDesignArtifact,
  cloneDesignArtifactValue,
  createDesignArtifactStore,
  deepMergeDesignPatch,
  defaultDesignArtifactValue,
  type DesignArtifactKind,
  type DesignArtifactValue,
} from "../world/design-artifacts.ts";

const artifactKindInput = z.enum(DESIGN_ARTIFACT_KINDS);

const setInput = z.object({
  artifact: artifactKindInput,
  value: z.unknown(),
}).strict();

const patchInput = z.object({
  artifact: artifactKindInput,
  patch: z.record(z.string(), z.unknown()),
}).strict();

const getInput = z.object({
  artifact: artifactKindInput,
}).strict();

const artifactOutput = z.object({
  artifact: artifactKindInput,
  value: z.unknown(),
});

function designStore(world: WorldContext) {
  if (world.design === undefined) world.design = createDesignArtifactStore();
  return world.design;
}

function storeCanonical(
  world: WorldContext,
  artifact: DesignArtifactKind,
  value: unknown,
): DesignArtifactValue {
  const canonical = canonicalizeDesignArtifact(artifact, value);
  designStore(world).artifacts.set(artifact, cloneDesignArtifactValue(canonical));
  return canonical;
}

export function registerDesignSkills(registry: SkillRegistry): void {
  const setSkill: SkillDefinition<z.infer<typeof setInput>, z.infer<typeof artifactOutput>> = {
    name: "design.set",
    version: "1.0.0",
    description: "Set a first-class design artifact on the world after schema validation and canonicalization.",
    category: "design",
    permissions: ["design.write"],
    input: setInput,
    output: artifactOutput,
    handler: (input, ctx) => {
      const canonical = storeCanonical(ctx.world, input.artifact, input.value);
      ctx.emit("design.artifactSet", { artifact: input.artifact });
      return { artifact: input.artifact, value: cloneDesignArtifactValue(canonical) };
    },
  };

  const patchSkill: SkillDefinition<z.infer<typeof patchInput>, z.infer<typeof artifactOutput>> = {
    name: "design.patch",
    version: "1.0.0",
    description: "Deep-merge a patch into a design artifact, then revalidate and store the canonical value.",
    category: "design",
    permissions: ["design.write"],
    input: patchInput,
    output: artifactOutput,
    handler: (input, ctx) => {
      const store = designStore(ctx.world);
      const current = store.artifacts.get(input.artifact);
      const seed = current ?? defaultDesignArtifactValue(input.artifact) ?? {};
      const merged = deepMergeDesignPatch(seed, input.patch);
      const canonical = storeCanonical(ctx.world, input.artifact, merged);
      ctx.emit("design.artifactPatched", { artifact: input.artifact });
      return { artifact: input.artifact, value: cloneDesignArtifactValue(canonical) };
    },
  };

  const getSkill: SkillDefinition<z.infer<typeof getInput>, z.infer<typeof artifactOutput>> = {
    name: "design.get",
    version: "1.0.0",
    description: "Read a first-class design artifact from the world without recording a mutation.",
    category: "design",
    permissions: ["design.read"],
    input: getInput,
    output: artifactOutput,
    handler: (input, ctx) => {
      const value = designStore(ctx.world).artifacts.get(input.artifact);
      return { artifact: input.artifact, value: value === undefined ? undefined : cloneDesignArtifactValue(value) };
    },
  };

  registry.register(setSkill);
  registry.register(patchSkill);
  registry.register(getSkill);
}
