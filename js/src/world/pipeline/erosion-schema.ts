import { z } from "../../../build/zod.bundle.mjs";
import { EROSION_RECIPE_SCHEMA } from "./erosion.mjs";

export const DisabledMapErosionRecipeSchema = z.object({
  schema: z.literal(EROSION_RECIPE_SCHEMA),
  enabled: z.literal(false),
}).strict();

export const EnabledMapErosionRecipeSchema = z.object({
  schema: z.literal(EROSION_RECIPE_SCHEMA),
  enabled: z.literal(true),
  rain: z.number().finite().min(0).max(2),
  thermal: z.number().int().min(0).max(32),
  talus: z.number().finite().min(0.000001).max(10_000),
  lifetime: z.number().int().min(1).max(64),
  capacity: z.number().finite().min(0.01).max(64),
  deposition: z.number().finite().min(0).max(1),
  erosionRate: z.number().finite().min(0).max(1),
}).strict().refine((recipe) => recipe.rain > 0 || recipe.thermal > 0, {
  message: "enabled erosion must perform hydraulic or thermal erosion; use disabled compatibility mode otherwise",
});

export const MapErosionRecipeSchema = z.union([
  DisabledMapErosionRecipeSchema,
  EnabledMapErosionRecipeSchema,
]);

export type MapErosionRecipe = z.infer<typeof MapErosionRecipeSchema>;
