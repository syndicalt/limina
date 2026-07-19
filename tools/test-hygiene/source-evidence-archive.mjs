#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(moduleDir, "../..");
export const MANIFEST_PATH = resolve(moduleDir, "source-evidence-archive.json");
export const ARCHIVE_ROOT = resolve(moduleDir, "historical-source-blobs");
export const SCHEMA = "limina.historical-source-evidence-archive/v1";
const HASH = /^sha256:[0-9a-f]{64}$/;
const SOURCE = /\.(?:c?js|mjs|mts|cts|jsx|tsx?|py)$/i;

const raw = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (path) => relative(REPO_ROOT, path).split(sep).join("/");
const archivePath = (hash) =>
  `tools/test-hygiene/historical-source-blobs/${hash.slice("sha256:".length)}.blob`;

// These are exact blobs already present in the transferred Git object database.
// Materialization still re-hashes every object before writing an inert .blob.
export const RECOVERABLE_GIT_BLOBS = new Map([
  ["sha256:cea19b23c5477d68f812bd8a636ee97c97ba3034c724aa4141cc2b8063262810", "3fce05e33453604150cdca26afa047a6d5d85e7a"],
  ["sha256:d9e0ccd97526eaa65a72cd3ee85e2d2ae0813792401e79893f39cc2d48161e7f", "0cd21ec047468b7396f551b51f25ba49ffcb63b9"],
  ["sha256:52e3eafaf2fc2f424c44bc64067674ad122e1cc7a5af1cae87dde01abbf1f171", "b93d89f8fb93124907f8898ccd3e6674c60eecd0"],
  ["sha256:4d28989301e209efbc73f709c9595fc2f72d39dee81e32be424f4dd784dd30b1", "5dac527b13b9f7fa8efbadff2618b7e0db7167ac"],
  ["sha256:2333c96958dda809ae3aa68a3df624d3113c06446f3e05737ac03b6a9aebf06b", "9618fe116c112d3d6c48ac035caa98b5a783f345"],
  ["sha256:3008c9a288e3e896dbcffece0e65a8a035da7c78a2c5a41a900146a539a41db9", "e9a7838ffba9c871550a389e6312d3ae8aa4510d"],
  ["sha256:643d1ccf99f23cbcbaaeb2f8f3e65617e982c12a6a2aacb78fb1c1e77ad73fa2", "3af319f22c7353278cadc138b558de0c63ee1dee"],
  ["sha256:ccf2142b238b9b8961e6c42138009f966654f05177bcc942b433841ae533902e", "774f7a14c18e2520fc4cb4fb34af84a99022c640"],
  ["sha256:9410b8dba44eebcc1434e843f13a5d3ef126d7d8aaeba7f7817ca15d80b73711", "1c43d73b4dd827e4ea2bf79a592b9f6aef24b09a"],
  ["sha256:9dd6cd95fb403945548b4b22e3f850e155d1dd60c0b38a818ca28632210cd007", "2aa5abe2d1d71ec07d7a2f19e7204d64fe61f6d7"],
  ["sha256:ae7a135c3b44e7ca57cb3d8f21910df2c357d988281ab0ac285e8ecebabc4d68", "e2085ff2bc9e551db0acf56444d26e27c1bd4526"],
  ["sha256:243363cb0c56bbf8e73f75d9859e8130bd1a70b60063daeb46d7471a041b4b7b", "3bc347c03421218f1503cc59a33009632e07e96d"],
  ["sha256:c1d2a96efec46f0f36fffd4a4436412135be4089600957c54359b40673ab1e6d", "ebee30e2f8d90173dcc2ebf684cf8e4cb6eb0ee3"],
  ["sha256:96ac8c84bd2dc58c28f11bb2f48169a87fd488c05c89a2cbaf02c5caad2d3cb8", "8bc997c317fcc57b7b29d26ba57ecf753668c34c"],
  ["sha256:3e2e3533b77bc5adb4c461c297c1a61ceb600e154de61dd23f790f751da03be1", "7148889910fcd29ab1ec4301bab9bcd2510740e3"],
  ["sha256:b2bf4e0b534b5e1c7a404684a81c1c343bcb34aa14a2450083dec8b11e9da41e", "ecbc5a67405905c36042484cb15c86e58532ba1e"],
  ["sha256:4a4d742fa628c14973063286d2ed7614dd2616635708f34d8b7dd55910369a60", "77d4d320eb95532bc464a7c3aaa1f31339166f26"],
  ["sha256:77ce7a8723a9bd4b16bf7b5108bf72db00f16e91fd5cd3cc0f3102f14eed257d", "ffa9fd2d5d027f55a988520d7d452fb78b2fe38f"],
  ["sha256:1c0d78074c261f4f8a5582378f946933a64ea5493ad1d8e88802972f27986450", "5b68c6c601cc7e7b6433f19d6416ad525129d555"],
  ["sha256:f14073e4ae6ffaf94c4becd5661cc6318ff2d263a8dcedc654d33bed7be90217", "99dc677780dd14c03c95cc423170b9816ad7e2e5"],
  ["sha256:711b75eabb49d794865080e9adcaca325cce83f1dea79cf379136aec7141ba47", "e5488a96797f69d9680b32b0e0f629c4dd708ab7"],
  ["sha256:b94af6c67b0cfbf1fd200ef6c3fccf16ceed9f8448c38936e544059fb15fb4b4", "4d2128343e02f5a037d7879853d2ac3d8fccce65"],
  ["sha256:38d11526f03a9909549aa7526b019ba9f239957e3783744540a8c12274c5e724", "7e3d82589e3cda6f0a7469341f6c2bf3dca3f415"],
  ["sha256:77522811e2a8b52462e7b83cd1948d7c125262c8fa2d4c1ccd3259c865a0c4a9", "22e5d7ff17e997f6963b49be3e3a6bbb54289313"],
  ["sha256:aa2edceae22e2be4869f5dd2d51d7cf375d51e7a2ca04975b13bcd7deba6f7f2", "bee921670a53ce0d5231882e38b34d591c6ccd03"],
]);

const PROD_AUTH =
  "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/production-review-authority-v5.json";
const PROD_DECISION =
  "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/production-review-decision-approve-v5.json";
const FB4_AUTH =
  "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/review-v4-r1/review-authority.json";
const FB4_DECISION =
  "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/review-v4-r1/hitl-decision-approve.json";

const set = (path, family, reviewStatus, lifecycle, decisionPath, successor) => ({
  path,
  family,
  reviewStatus,
  lifecycle,
  decisionPath,
  successor,
});

export const EVIDENCE_SET_SPECS = Object.freeze([
  set(
    "assets/qc/internal/compositions/functional-hall-house-v4-c1-r2-v1/capture-evidence.json",
    "composition",
    "revised",
    "superseded",
    "assets/qc/internal/compositions/functional-hall-house-v4-c1-r2-v1/review-decision-revise.json",
    {
      authorityPath:
        "assets/buildings/authoring/functional-hall-house-v4/composition-r3/review-authority-v2.json",
      decisionPath:
        "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/review-decision-approve.json",
    },
  ),
  set(
    "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v1/capture-evidence.json",
    "composition",
    "intermediate",
    "superseded",
    null,
    {
      authorityPath:
        "assets/buildings/authoring/functional-hall-house-v4/composition-r3/review-authority-v2.json",
      decisionPath:
        "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/review-decision-approve.json",
    },
  ),
  set(
    "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/capture-evidence.json",
    "composition",
    "approved",
    "current-component",
    "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/review-decision-approve.json",
    { authorityPath: PROD_AUTH, decisionPath: PROD_DECISION },
  ),
  set(
    "assets/qc/internal/fb4-multi-room/program-v2-1b4470041e01-r1/capture-provenance.json",
    "fb4",
    "intermediate",
    "superseded",
    null,
    { authorityPath: FB4_AUTH, decisionPath: FB4_DECISION },
  ),
  set(
    "assets/qc/internal/fb4-multi-room/program-v3-1f375ec3abe1-v4-r1/capture-provenance.json",
    "fb4",
    "approved",
    "current-release",
    FB4_DECISION,
    null,
  ),
  ...["r2", "r3"].map((revision) =>
    set(
      `assets/qc/internal/fb4-multi-room/program-v3-a11f21423016-v4-${revision}/capture-provenance.json`,
      "fb4",
      "intermediate",
      "superseded",
      null,
      { authorityPath: FB4_AUTH, decisionPath: FB4_DECISION },
    ),
  ),
  set(
    "assets/qc/internal/fb4-multi-room/program-v3-a11f21423016-v4-r4/capture-provenance.json",
    "fb4",
    "revised",
    "superseded",
    "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-a11f21423016/review-v4-r4/hitl-decision-revise.json",
    { authorityPath: FB4_AUTH, decisionPath: FB4_DECISION },
  ),
  ...["r12", "r13", "r14"].map((revision) =>
    set(
      `assets/qc/internal/fire/functional-hall-house-v4-v1-volumetric-${revision}/capture-evidence.json`,
      "fire",
      "intermediate",
      "superseded",
      null,
      {
        authorityPath:
          "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-review-authority-r7.json",
        decisionPath:
          "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-review-decision-approve-r15.json",
      },
    ),
  ),
  set(
    "assets/qc/internal/fire/functional-hall-house-v4-v1-volumetric-r15/capture-evidence.json",
    "fire",
    "approved",
    "current-component",
    "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-review-decision-approve-r15.json",
    { authorityPath: PROD_AUTH, decisionPath: PROD_DECISION },
  ),
  set(
    "assets/qc/internal/interiors/functional-hall-house-v4/i1-r2/capture-evidence.json",
    "interior",
    "approved",
    "superseded",
    "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-review-decision-approve.json",
    {
      authorityPath:
        "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-review-authority.json",
      decisionPath:
        "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-review-decision-approve.json",
    },
  ),
  set(
    "assets/qc/internal/interiors/functional-hall-house-v4/i1-r2-yaw-r1/capture-evidence.json",
    "interior",
    "approved",
    "superseded",
    "assets/buildings/authoring/functional-hall-house-v4/interior-r2/interior-review-decision-approve.json",
    {
      authorityPath:
        "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-review-authority.json",
      decisionPath:
        "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-review-decision-approve.json",
    },
  ),
  set(
    "assets/qc/internal/interiors/functional-hall-house-v4/i1-r3/capture-evidence.json",
    "interior",
    "approved",
    "superseded",
    "assets/buildings/authoring/functional-hall-house-v4/interior-r3/interior-review-decision-approve.json",
    {
      authorityPath:
        "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-review-authority.json",
      decisionPath:
        "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-review-decision-approve.json",
    },
  ),
  set(
    "assets/qc/internal/interiors/functional-hall-house-v4/i1-r4/capture-evidence.json",
    "interior",
    "approved",
    "current-component",
    "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-review-decision-approve.json",
    { authorityPath: PROD_AUTH, decisionPath: PROD_DECISION },
  ),
  set(
    "assets/qc/internal/production-r1/r1-v4-spark-20260716/capture-evidence.json",
    "production-r1",
    "intermediate",
    "superseded",
    null,
    { authorityPath: PROD_AUTH, decisionPath: PROD_DECISION },
  ),
  set(
    "assets/qc/internal/production-r1/r1-v5-spark-20260716/capture-evidence.json",
    "production-r1",
    "approved",
    "current-release",
    PROD_DECISION,
    null,
  ),
]);

export const HISTORY_DOCUMENTS = Object.freeze([
  "art-direction/functional-cottage-review-scene.json",
  "art-direction/functional-cottage-v4-iteration.json",
]);

// This approved authority is not rewritten to follow mutable source paths. Its
// exact historical producer reference is dispositioned here instead.
export const TRANSITION_AUTHORITY_DOCUMENTS = Object.freeze([
  "assets/buildings/authoring/functional-hall-house-v4/shell-review-authority.json",
]);

const formattedSourcePaths = new Set([
  "js/src/architecture/building-articulation-cpu-proxy.ts",
  "js/src/architecture/furniture-design-contract.ts",
  "js/src/architecture/visual-design-contract.ts",
  "js/src/assets/building-fire-runtime-v2.mjs",
  "js/src/assets/functional-building-contract.ts",
  "js/src/assets/functional-building-site-artifact.mjs",
  "js/src/demos/building_composition_capture_window.ts",
  "js/src/demos/building_fire_capture_window.ts",
  "js/src/demos/building_multi_room_review_window.ts",
  "js/src/demos/building_production_review_window.ts",
  "js/src/demos/staged_interior_proxy_capture_window.ts",
  "js/src/render/building-composition-review-scene.ts",
  "js/src/render/building-fire-review-authority.ts",
  "js/src/render/building-multi-room-review-scene.ts",
  "js/src/render/building-production-review-authority.ts",
  "js/src/render/building-semantic-evidence.ts",
  "js/src/render/building-site-review-envelope.ts",
  "js/src/render/fb4-capture-provenance.ts",
  "js/src/render/staged-interior-proxy-review-scene.ts",
  "js/src/skills/asset.ts",
  "js/src/skills/material.ts",
  "js/src/skills/scene.ts",
  "js/src/skills/terrain.ts",
  "js/src/skills/village.ts",
  "tools/architecture/build-building.ts",
  "tools/architecture/build-shell.ts",
  "tools/asset/batch-architecture-building.mjs",
  "tools/asset/batch-hall-house-v4.mjs",
  "tools/asset/compress-hall-house-v4-ktx2.mjs",
  "tools/blender/architecture-adapter.py",
  "tools/blender/functional-hall-house-v4.py",
]);

function sourceReferences(value, evidencePath) {
  const rows = [];
  const walk = (node, location = []) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, [...location, index]));
    for (const [pathKey, sourcePath] of Object.entries(node)) {
      if (typeof sourcePath !== "string" || !/(?:^path$|path$)/i.test(pathKey)) continue;
      if (!formattedSourcePaths.has(sourcePath) || !SOURCE.test(sourcePath)) continue;
      const stem = pathKey.replace(/path$/i, "");
      const expectedHashKey = pathKey.toLowerCase() === "path" ? "sha256" : `${stem}Sha256`;
      const match = Object.entries(node).find(
        ([key, hash]) => key.toLowerCase() === expectedHashKey.toLowerCase() && typeof hash === "string" && HASH.test(hash),
      );
      if (!match) continue;
      const [hashKey, expectedSha256] = match;
      rows.push({
        evidencePath,
        jsonLocation: [...location, pathKey].join("."),
        sourcePath,
        hashKey,
        expectedSha256,
      });
    }
    for (const [key, entry] of Object.entries(node)) walk(entry, [...location, key]);
  };
  walk(value);
  return rows;
}

async function identity(path) {
  const bytes = await readFile(resolve(REPO_ROOT, path));
  return { path, sha256: raw(bytes) };
}

function authorityRecord(value) {
  return value.authority ?? value.subject?.reviewAuthority ?? null;
}

async function evidenceSetRecord(spec) {
  const bytes = await readFile(resolve(REPO_ROOT, spec.path));
  const value = JSON.parse(bytes.toString("utf8"));
  const authority = authorityRecord(value);
  if (!authority?.path || !HASH.test(authority.sha256)) throw new Error(`${spec.path} lacks exact authority identity`);
  const exactAuthority = await identity(authority.path);
  if (exactAuthority.sha256 !== authority.sha256) throw new Error(`${spec.path} authority bytes drifted`);
  return {
    path: spec.path,
    sha256: raw(bytes),
    family: spec.family,
    reviewStatus: spec.reviewStatus,
    lifecycle: spec.lifecycle,
    authority: exactAuthority,
    decision: spec.decisionPath ? await identity(spec.decisionPath) : null,
    successor: spec.successor
      ? {
          authority: await identity(spec.successor.authorityPath),
          decision: await identity(spec.successor.decisionPath),
        }
      : null,
    sourceReferences: sourceReferences(value, spec.path),
  };
}

export async function buildManifest() {
  const evidenceSets = [];
  for (const spec of EVIDENCE_SET_SPECS) evidenceSets.push(await evidenceSetRecord(spec));
  const historyDocuments = [];
  for (const path of HISTORY_DOCUMENTS) {
    const bytes = await readFile(resolve(REPO_ROOT, path));
    historyDocuments.push({
      path,
      sha256: raw(bytes),
      status: "append-only-historical-provenance",
      sourceReferences: sourceReferences(JSON.parse(bytes.toString("utf8")), path),
    });
  }
  const transitionAuthorities = [];
  for (const path of TRANSITION_AUTHORITY_DOCUMENTS) {
    const bytes = await readFile(resolve(REPO_ROOT, path));
    transitionAuthorities.push({
      path,
      sha256: raw(bytes),
      status: "approved-authority-source-transition",
      sourceReferences: sourceReferences(JSON.parse(bytes.toString("utf8")), path),
    });
  }
  const all = [
    ...evidenceSets.flatMap((record) => record.sourceReferences),
    ...historyDocuments.flatMap((record) => record.sourceReferences),
    ...transitionAuthorities.flatMap((record) => record.sourceReferences),
  ];
  const sourceReferencesWithArchive = [];
  for (const row of all) {
    const currentSha256 = raw(await readFile(resolve(REPO_ROOT, row.sourcePath)));
    if (currentSha256 === row.expectedSha256) continue;
    const oid = RECOVERABLE_GIT_BLOBS.get(row.expectedSha256);
    sourceReferencesWithArchive.push({
      ...row,
      currentAtRemediationSha256: currentSha256,
      reproducibility: oid
        ? {
            status: "archived-exact",
            archivePath: archivePath(row.expectedSha256),
            archiveSha256: row.expectedSha256,
            recoveryGitBlobOid: oid,
          }
        : {
            status: "hash-attested-only",
            archivePath: null,
            archiveSha256: null,
            recoveryGitBlobOid: null,
          },
    });
  }
  sourceReferencesWithArchive.sort((a, b) =>
    a.evidencePath.localeCompare(b.evidencePath) ||
    a.jsonLocation.localeCompare(b.jsonLocation) ||
    a.sourcePath.localeCompare(b.sourcePath),
  );
  const productionTransitions = sourceReferencesWithArchive
    .filter(
      (row) =>
        row.evidencePath ===
        "assets/qc/internal/production-r1/r1-v5-spark-20260716/capture-evidence.json",
    )
    .map((row) => ({
      evidencePath: row.evidencePath,
      sourcePath: row.sourcePath,
      historicalSha256: row.expectedSha256,
      archivePath: row.reproducibility.archivePath,
      currentSha256: row.currentAtRemediationSha256,
      recipe: "prettier:3.9.5+typescript-transpile-equivalence/v1",
    }));
  if (productionTransitions.length !== 2 || productionTransitions.some((row) => !row.archivePath)) {
    throw new Error("production-v5 transition must contain exactly two fully archived source references");
  }
  const shellTransition = sourceReferencesWithArchive.find(
    (row) =>
      row.evidencePath === TRANSITION_AUTHORITY_DOCUMENTS[0] &&
      row.jsonLocation === "source.buildToolPath" &&
      row.sourcePath === "tools/architecture/build-shell.ts",
  );
  if (!shellTransition || shellTransition.reproducibility.status !== "archived-exact") {
    throw new Error("staged-shell authority transition lacks exact historical build-tool bytes");
  }
  const transitions = [
    ...productionTransitions,
    {
      evidencePath: shellTransition.evidencePath,
      sourcePath: shellTransition.sourcePath,
      historicalSha256: shellTransition.expectedSha256,
      archivePath: shellTransition.reproducibility.archivePath,
      currentSha256: shellTransition.currentAtRemediationSha256,
      recipe: "prettier:3.9.5+typescript-transpile-equivalence/v1",
    },
  ];
  const prettierConfig = await identity(".prettierrc.json");
  return {
    schema: SCHEMA,
    policy: {
      historicalEvidenceIsImmutable: true,
      mutableWorkspacePathsAreNotHistoricalBytes: true,
      hashAttestedOnlyMayAuthorizeTransition: false,
      newCapturesRequireCompleteSourceArchive: true,
      renderedChangesRequireNewHitlApproval: true,
    },
    formatter: {
      package: "prettier",
      version: "3.9.5",
      config: prettierConfig,
    },
    evidenceSets: evidenceSets.map(({ sourceReferences: _, ...record }) => record),
    historyDocuments: historyDocuments.map(({ sourceReferences: _, ...record }) => record),
    transitionAuthorities: transitionAuthorities.map(({ sourceReferences: _, ...record }) => record),
    sourceReferences: sourceReferencesWithArchive,
    transitions,
  };
}

export async function materializeArchives() {
  await mkdir(ARCHIVE_ROOT, { recursive: true, mode: 0o755 });
  for (const [expected, oid] of RECOVERABLE_GIT_BLOBS) {
    const bytes = execFileSync("git", ["cat-file", "blob", oid], {
      cwd: REPO_ROOT,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (raw(bytes) !== expected) throw new Error(`Git blob ${oid} does not match ${expected}`);
    const path = resolve(REPO_ROOT, archivePath(expected));
    await writeFile(path, bytes, { flag: "wx", mode: 0o444 }).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      if (raw(await readFile(path)) !== expected) throw new Error(`archive collision at ${portable(path)}`);
    });
    await chmod(path, 0o444);
  }
}

export async function writeManifest() {
  const manifest = await buildManifest();
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

function outputRecords(value) {
  const outputs = Array.isArray(value.outputs) ? value.outputs : [];
  return outputs.filter((entry) => entry && typeof entry === "object" && typeof entry.path === "string");
}

async function verifyOutputs(evidencePath) {
  const value = JSON.parse(await readFile(resolve(REPO_ROOT, evidencePath), "utf8"));
  for (const output of outputRecords(value)) {
    if (!HASH.test(output.pngSha256)) throw new Error(`${evidencePath} output ${output.path} lacks PNG SHA-256`);
    const bytes = await readFile(resolve(REPO_ROOT, output.path));
    if (raw(bytes) !== output.pngSha256) throw new Error(`${evidencePath} output bytes drifted: ${output.path}`);
    if (output.pngByteLength !== undefined && output.pngByteLength !== bytes.byteLength) {
      throw new Error(`${evidencePath} output byte length drifted: ${output.path}`);
    }
  }
}

async function verifyIdentity(record, label) {
  const bytes = await readFile(resolve(REPO_ROOT, record.path));
  if (raw(bytes) !== record.sha256) throw new Error(`${label} drifted: ${record.path}`);
}

function transpile(typescript, source, fileName) {
  const parsed = typescript.createSourceFile(
    fileName,
    source,
    typescript.ScriptTarget.ES2022,
    true,
    fileName.endsWith(".ts") ? typescript.ScriptKind.TS : typescript.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics?.some((entry) => entry.category === typescript.DiagnosticCategory.Error)) {
    throw new Error(`${fileName} has TypeScript AST parse errors`);
  }
  const result = typescript.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ESNext,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: false,
      // Comments and source trivia are deliberately excluded: exact old->current
      // bytes are already proven by pinned Prettier above. This comparison asks
      // the TypeScript emitter whether the executable module is identical.
      removeComments: true,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (entry) => entry.category === typescript.DiagnosticCategory.Error,
  );
  if (errors.length) throw new Error(`${fileName} has TypeScript transpile errors`);
  return result.outputText;
}

function astFingerprint(typescript, source, fileName, scriptKind) {
  const file = typescript.createSourceFile(
    fileName,
    source,
    typescript.ScriptTarget.ES2022,
    true,
    scriptKind,
  );
  if (file.parseDiagnostics?.some((entry) => entry.category === typescript.DiagnosticCategory.Error)) {
    throw new Error(`${fileName} has AST parse errors`);
  }
  const visit = (node) => {
    const children = [];
    typescript.forEachChild(node, (child) => children.push(visit(child)));
    return children.length ? [node.kind, children] : [node.kind, node.getText(file)];
  };
  return JSON.stringify(visit(file));
}

export async function verifyManifest(inputManifest) {
  const manifest =
    inputManifest ?? JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (manifest.schema !== SCHEMA) throw new Error("historical source manifest schema drifted");
  if (manifest.policy?.hashAttestedOnlyMayAuthorizeTransition !== false) {
    throw new Error("hash-attested-only sources must never authorize a transition");
  }
  if (manifest.evidenceSets.length !== EVIDENCE_SET_SPECS.length) {
    throw new Error("historical evidence-set inventory is incomplete");
  }
  for (const record of manifest.evidenceSets) {
    await verifyIdentity(record, "historical evidence");
    await verifyIdentity(record.authority, "historical authority");
    if (record.decision) await verifyIdentity(record.decision, "historical decision");
    if (record.successor) {
      await verifyIdentity(record.successor.authority, "successor authority");
      await verifyIdentity(record.successor.decision, "successor decision");
    }
    await verifyOutputs(record.path);
  }
  for (const record of manifest.historyDocuments) await verifyIdentity(record, "historical provenance document");
  for (const record of manifest.transitionAuthorities) await verifyIdentity(record, "transition authority");
  for (const row of manifest.sourceReferences) {
    if (!HASH.test(row.expectedSha256) || !HASH.test(row.currentAtRemediationSha256)) {
      throw new Error(`invalid source ledger hash at ${row.evidencePath}:${row.jsonLocation}`);
    }
    if (row.reproducibility.status === "archived-exact") {
      if (extname(row.reproducibility.archivePath) !== ".blob") {
        throw new Error(`historical archive is executable source: ${row.reproducibility.archivePath}`);
      }
      const path = resolve(REPO_ROOT, row.reproducibility.archivePath);
      const bytes = await readFile(path);
      if (raw(bytes) !== row.expectedSha256 || raw(bytes) !== row.reproducibility.archiveSha256) {
        throw new Error(`historical archive drifted: ${row.reproducibility.archivePath}`);
      }
      if ((await stat(path)).mode & 0o111) throw new Error(`historical archive is executable: ${row.reproducibility.archivePath}`);
    } else if (
      row.reproducibility.status !== "hash-attested-only" ||
      row.reproducibility.archivePath !== null ||
      row.reproducibility.archiveSha256 !== null ||
      row.reproducibility.recoveryGitBlobOid !== null
    ) {
      throw new Error(`invalid legacy hash-only disposition at ${row.evidencePath}:${row.jsonLocation}`);
    }
  }

  const packageJson = JSON.parse(await readFile(resolve(REPO_ROOT, "js/package.json"), "utf8"));
  const prettierJson = JSON.parse(await readFile(resolve(REPO_ROOT, "js/node_modules/prettier/package.json"), "utf8"));
  if (
    packageJson.devDependencies?.prettier !== manifest.formatter.version ||
    prettierJson.version !== manifest.formatter.version
  ) {
    throw new Error("production transition requires the exact pinned and installed Prettier version");
  }
  await verifyIdentity(manifest.formatter.config, "Prettier config");
  const typescript = await import(resolve(REPO_ROOT, "js/node_modules/typescript/lib/typescript.js"));
  for (const transition of manifest.transitions) {
    const row = manifest.sourceReferences.find(
      (entry) =>
        entry.evidencePath === transition.evidencePath &&
        entry.sourcePath === transition.sourcePath &&
        entry.expectedSha256 === transition.historicalSha256,
    );
    if (!row || row.reproducibility.status !== "archived-exact" || !transition.archivePath) {
      throw new Error(`transition lacks exact historical bytes: ${transition.sourcePath}`);
    }
    const oldBytes = await readFile(resolve(REPO_ROOT, transition.archivePath));
    const currentBytes = await readFile(resolve(REPO_ROOT, transition.sourcePath));
    if (raw(currentBytes) !== transition.currentSha256) {
      throw new Error(`transition current source drifted: ${transition.sourcePath}`);
    }
    const formatted = spawnSync(
      resolve(REPO_ROOT, "js/node_modules/.bin/prettier"),
      ["--config", resolve(REPO_ROOT, manifest.formatter.config.path), "--stdin-filepath", transition.sourcePath],
      { cwd: REPO_ROOT, input: oldBytes, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    if (formatted.status !== 0) throw new Error(`Prettier transition failed: ${transition.sourcePath}`);
    if (!Buffer.from(formatted.stdout).equals(currentBytes)) {
      throw new Error(`pinned Prettier does not produce current bytes: ${transition.sourcePath}`);
    }
    const oldJs = transpile(typescript, oldBytes.toString("utf8"), transition.sourcePath);
    const currentJs = transpile(typescript, currentBytes.toString("utf8"), transition.sourcePath);
    if (
      astFingerprint(
        typescript,
        oldBytes.toString("utf8"),
        transition.sourcePath,
        typescript.ScriptKind.TS,
      ) !==
        astFingerprint(
          typescript,
          currentBytes.toString("utf8"),
          transition.sourcePath,
          typescript.ScriptKind.TS,
        ) ||
      astFingerprint(typescript, oldJs, `${transition.sourcePath}.old.js`, typescript.ScriptKind.JS) !==
        astFingerprint(
          typescript,
          currentJs,
          `${transition.sourcePath}.current.js`,
          typescript.ScriptKind.JS,
        )
    ) {
      throw new Error(`TypeScript AST/transpiled semantics drifted: ${transition.sourcePath}`);
    }
  }
  const rebuilt = await buildManifest();
  if (JSON.stringify(rebuilt) !== JSON.stringify(manifest)) {
    throw new Error("source-evidence archive manifest is stale or manually edited");
  }
  return {
    evidenceSets: manifest.evidenceSets.length,
    sourceReferences: manifest.sourceReferences.length,
    archived: manifest.sourceReferences.filter((row) => row.reproducibility.status === "archived-exact").length,
    hashAttestedOnly: manifest.sourceReferences.filter(
      (row) => row.reproducibility.status === "hash-attested-only",
    ).length,
    transitions: manifest.transitions.length,
  };
}

async function main() {
  const command = process.argv[2] ?? "verify";
  if (command === "materialize") {
    await materializeArchives();
    const manifest = await writeManifest();
    console.log(`materialized ${RECOVERABLE_GIT_BLOBS.size} inert historical blobs and ${manifest.sourceReferences.length} exact source-reference rows`);
  } else if (command === "verify") {
    console.log(JSON.stringify(await verifyManifest(), null, 2));
  } else {
    throw new Error("usage: source-evidence-archive.mjs [materialize|verify]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
