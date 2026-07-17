import { biomeDefContentHash, biomePackContentHash, parseBiomePack } from "./biome-ir.mjs";

export class BiomeRegistry {
  #packs = new Map();
  #definitions = new Map();

  install(input) {
    const pack = parseBiomePack(input);
    const address = biomePackContentHash(pack);
    const key = `${pack.id}@${pack.version}`;
    const current = this.#packs.get(key);
    if (current !== undefined) {
      if (current.address !== address) throw new Error(`biome pack '${key}' conflicts with installed content ${current.address}`);
      return Object.freeze({ installed: false, address, pack: current.pack });
    }
    for (const definition of pack.definitions) {
      const definitionKey = `${definition.id}@${definition.version}`;
      const owner = this.#definitions.get(definitionKey);
      if (owner !== undefined) throw new Error(`biome definition '${definitionKey}' is already owned by pack '${owner.packKey}'`);
    }
    const entry = Object.freeze({ address, pack });
    this.#packs.set(key, entry);
    for (const definition of pack.definitions) this.#definitions.set(`${definition.id}@${definition.version}`, Object.freeze({
      packKey: key, definition, address: biomeDefContentHash(definition),
    }));
    return Object.freeze({ installed: true, address, pack });
  }

  pack(id, version) { return this.#packs.get(`${id}@${version}`)?.pack ?? null; }
  definition(id, version) { return this.#definitions.get(`${id}@${version}`)?.definition ?? null; }
  definitionAddress(id, version) { return this.#definitions.get(`${id}@${version}`)?.address ?? null; }
  resolveLegacy(packId, version, legacyKind) {
    const pack = this.pack(packId, version);
    const biomeId = pack?.legacyAliases.find((entry) => entry.legacyKind === legacyKind)?.biomeId;
    // Definition versions are independently content-addressed and need not equal the pack version.
    return biomeId === undefined ? null : pack.definitions.find((definition) => definition.id === biomeId) ?? null;
  }
  packs() {
    const result = [...this.#packs.values()].map((entry) => Object.freeze({ id: entry.pack.id, version: entry.pack.version, address: entry.address }));
    result.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
    return Object.freeze(result);
  }
  definitions() {
    const result = [...this.#definitions.values()].map((entry) => entry.definition);
    result.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
    return Object.freeze(result);
  }
}
