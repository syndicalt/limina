import type { AssetRegistry } from "../asset-registry.ts";
import { parseBiomePopulationAsset } from "../world/biome-population-asset.mjs";
import { continuousGrassDensityVariation } from "./continuous-grass-density-variation.ts";

interface GrassContribution { readonly weight01: number; readonly role: string; readonly binding: Readonly<{ assetId: string; contentHash: string }> }
interface BiomeSample { readonly vegetationDensity01: number; readonly vegetation: readonly GrassContribution[] }
interface Publication {
  readonly disposed: boolean;
  sample(x: number, z: number): BiomeSample | null;
  sampleVegetation?(x: number, z: number): BiomeSample | null;
}

export class BiomeGrassDensitySampler {
  private readonly descriptors = new Map<string, any>();
  constructor(private readonly publication: Publication, private readonly assets: AssetRegistry) {
    if (publication.disposed) throw new Error("biome grass density requires a live runtime publication");
  }

  private descriptor(entry: GrassContribution): any {
    const key = `${entry.binding.assetId}\u0000${entry.binding.contentHash}`;
    const cached = this.descriptors.get(key); if (cached !== undefined) return cached;
    const resolved = this.assets.resolve(entry.binding.assetId);
    if (resolved.hash !== entry.binding.contentHash) throw new Error(`biome grass descriptor '${entry.binding.assetId}' content hash mismatch`);
    let parsed: any;
    try { parsed = parseBiomePopulationAsset(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes))); }
    catch (error) { throw new Error(`biome grass descriptor '${entry.binding.assetId}' is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    if (parsed.role !== entry.role) throw new Error(`biome grass descriptor '${entry.binding.assetId}' role mismatch`);
    this.descriptors.set(key, parsed); return parsed;
  }

  private vegetationAt(x: number, z: number): BiomeSample | null {
    return this.publication.sampleVegetation === undefined
      ? this.publication.sample(x, z)
      : this.publication.sampleVegetation(x, z);
  }

  sample(x: number, z: number): number {
    const sample = this.vegetationAt(x, z); if (sample === null) return 0;
    let density = 0;
    for (const entry of sample.vegetation) {
      const descriptor = this.descriptor(entry);
      if (descriptor.backend === "grass-field" || descriptor.backend === "continuous-grass-field") {
        density += sample.vegetationDensity01 * entry.weight01 * descriptor.densityScale;
      }
    }
    return continuousGrassDensityVariation(Math.max(0, Math.min(1, density)), x, z);
  }

  sampleBinding(x: number, z: number, assetId: string, contentHash: string): number {
    const sample = this.vegetationAt(x, z); if (sample === null) return 0;
    let density = 0;
    for (const entry of sample.vegetation) {
      if (entry.binding.assetId !== assetId || entry.binding.contentHash !== contentHash) continue;
      const descriptor = this.descriptor(entry);
      if (descriptor.backend === "continuous-grass-field") {
        density += sample.vegetationDensity01 * entry.weight01 * descriptor.densityScale;
      }
    }
    return continuousGrassDensityVariation(Math.max(0, Math.min(1, density)), x, z);
  }

  profile(x: number, z: number): Readonly<{ climate: "summer" | "autumn" | "winter" | "dry"; bladeScale: readonly [number, number] }> | null {
    const sample = this.vegetationAt(x, z); if (sample === null) return null;
    let selected: any, best = -1;
    for (const entry of sample.vegetation) {
      const descriptor = this.descriptor(entry);
      if (descriptor.backend !== "grass-field" && descriptor.backend !== "continuous-grass-field") continue;
      const score = sample.vegetationDensity01 * entry.weight01 * descriptor.densityScale;
      if (score > best || (score === best && descriptor.id < selected.id)) { best = score; selected = descriptor; }
    }
    return selected === undefined ? null : Object.freeze({ climate: selected.climate, bladeScale: selected.bladeScale });
  }
}
