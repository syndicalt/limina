import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateBiomePublicationContentEntries } from "../../js/src/world/compiler/biome-publication-compile.mjs";
import { compilerContentHash } from "../../js/src/world/compiler/canonical.mjs";
import * as worldCompiler from "../../js/build/world-compiler.bundle.mjs";
import { publishDerivedRevision } from "../design/derived-publisher.mjs";
import { DerivedRuntimeServer } from "../design/derived-runtime-server.mjs";
import { loadFrozenBiomePublicationBundle } from "../design/derived-build-service.mjs";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const assetRoot = resolve(repo, "assets");
const worldMapPath = resolve(assetRoot, "maps/temperate-fidelity-primary.worldmap.json");

test("the exact frozen provider compiles, atomically publishes, and serves an authenticated 1.4 revision", async () => {
  const provider = loadFrozenBiomePublicationBundle({
    assetRoot,
    bundleAssetId: "derived/temperate-fidelity/runtime/bundle.json",
    worldMapAssetId: "maps/temperate-fidelity-primary.worldmap.json",
  });
  const worldMap = JSON.parse(readFileSync(worldMapPath, "utf8"));
  assert.equal(provider.matches(worldMap), true);

  const publication = provider.prepare({ worldMap });
  assert.equal(publication.input.chunks.length, 256);
  assert.equal(validateBiomePublicationContentEntries(
    publication.input,
    publication.contentEntries,
  ).length, 45);

  const template = worldCompiler.createPublishedBiomeWorldTerrainCompiler("temperate-fidelity");
  assert.equal(template.identity.graphHash, provider.compilerGraphHash);
  const request = {
      projectId: "temperate-fidelity",
      branchId: "main",
      revision: 1,
      headHash: compilerContentHash({ test: "frozen-biome-production" }),
  };
  const output = worldCompiler.compileWorldTerrain({
    request,
    worldMap,
    sourceRefs: {
      mapDocument: {
        refId: "map-document", refType: "map-document/v1", scope: "global",
        assetId: "maps/temperate-fidelity-primary.map.json",
        contentHash: `sha256:${worldMap.provenance.sourceHash}`,
      },
      designSource: {
        refId: "design-source", refType: "design-source/v1", scope: "global",
        assetId: "maps/temperate-fidelity-primary.source.json",
        contentHash: `sha256:${worldMap.provenance.sourceHash}`,
      },
      worldMap: {
        refId: "world-map", refType: "world-map/v1", scope: "global",
        assetId: "maps/temperate-fidelity-primary.worldmap.json",
        contentHash: `sha256:${worldMap.provenance.contentHash}`,
      },
    },
    terrainEditLayers: [],
    terrainEditLayerRefs: [],
    compiler: { version: template.version, config: provider.compilerConfig },
    biomePublication: publication.input,
    previousSnapshot: null,
    cancellation: { shouldCancel: () => false },
  });
  assert.equal(output.manifest.compiler.version, "1.4.0");
  assert.equal(output.manifest.compiler.configHash, compilerContentHash(provider.compilerConfig));
  assert.equal(output.manifest.chunks.length, 256);
  assert.equal(output.manifest.chunks.every((chunk) => chunk.artifacts.length === 3), true);
  assert.equal(output.reusedArtifacts.length, 0);

  const projectRoot = mkdtempSync(resolve(tmpdir(), "limina-frozen-publication-"));
  mkdirSync(resolve(projectRoot, "assets"));
  mkdirSync(resolve(projectRoot, ".limina"));
  writeFileSync(resolve(projectRoot, "limina.project.json"), `${JSON.stringify({
    schema: "limina-project/1",
    projectId: request.projectId,
    assetRoot: "assets",
    stateDir: ".limina",
  })}\n`);
  const readHead = async () => request;
  let runtime;
  try {
    const published = await publishDerivedRevision({
      projectRoot,
      jobId: "frozen-biome-production",
      manifest: output.manifest,
      artifacts: output.artifacts,
      reusedArtifacts: output.reusedArtifacts,
      snapshot: output.snapshot,
      contentEntries: publication.contentEntries,
      readHead,
    });
    assert.equal(published.published, true);
    runtime = new DerivedRuntimeServer({
      projectId: request.projectId,
      projectRoot,
      branchId: request.branchId,
      readHead,
      token: new Uint8Array(32).fill(0x6d),
      port: 0,
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: ["http://localhost:5173"],
    });
    const owner = await runtime.start();
    const headers = { Authorization: `Bearer ${owner.token}`, Origin: "http://localhost:5173" };
    assert.equal((await fetch(`${owner.baseUrl}/v1/derived/current`, { headers: { Origin: headers.Origin } })).status, 401);
    const current = await fetch(`${owner.baseUrl}/v1/derived/current`, { headers });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).manifest.manifestHash, output.manifest.manifestHash);

    const closure = output.manifest.globalArtifacts.find((entry) => entry.artifactType === "biome-content-closure/v1");
    assert.ok(closure);
    const artifactResponse = await fetch(`${owner.baseUrl}/v1/derived/manifests/${output.manifest.manifestHash.slice(7)}/artifacts/${closure.contentHash.slice(7)}`, { headers });
    assert.equal(artifactResponse.status, 200);
    assert.equal((await artifactResponse.arrayBuffer()).byteLength, closure.byteLength);

    const content = publication.contentEntries[0];
    const contentResponse = await fetch(`${owner.baseUrl}/v1/derived/manifests/${output.manifest.manifestHash.slice(7)}/content/${content.hash.slice(7)}`, { headers });
    assert.equal(contentResponse.status, 200);
    assert.equal((await contentResponse.arrayBuffer()).byteLength, content.bytes.byteLength);
  } finally {
    await runtime?.stop();
    rmSync(projectRoot, { recursive: true, force: true });
  }

  const tampered = structuredClone(worldMap);
  tampered.name = `${tampered.name ?? "temperate-fidelity"}-tampered`;
  assert.equal(provider.matches(tampered), false);
  assert.throws(
    () => provider.prepare({ worldMap: tampered }),
    /frozen biome publication does not match this WorldMap/,
  );
});
