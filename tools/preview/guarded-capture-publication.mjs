import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCaptureProducerClosure,
  verifyCaptureSourceArchive,
  writeCaptureSourceArchive,
} from "./capture-producer-closure.mjs";
import { runNativeCaptureWithXidGuard } from "./xid-guard.mjs";

export const GUARDED_CAPTURE_PUBLICATION_SCHEMA = "limina.guarded-capture-publication/v1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACTS = Object.freeze(
  [
    ["run-native-building-composition-capture.mjs", "js/src/demos/building_composition_capture_window.ts"],
    ["run-native-building-fire-capture.mjs", "js/src/demos/building_fire_capture_window.ts"],
    ["run-native-building-production-r1-capture.mjs", "js/src/demos/building_production_review_window.ts"],
    ["run-native-fb4-multi-room-capture.mjs", "js/src/demos/building_multi_room_review_window.ts"],
    ["run-native-functional-cottage-capture.mjs", "js/src/demos/functional_cottage_capture_window.ts"],
    ["run-native-furniture-pack-capture.mjs", "js/src/demos/furniture_pack_capture_window.ts"],
    ["run-native-staged-interior-proxy-capture.mjs", "js/src/demos/staged_interior_proxy_capture_window.ts"],
    ["run-native-staged-material-capture.mjs", "js/src/demos/staged_material_capture_window.ts"],
    ["run-native-staged-shell-capture.mjs", "js/src/demos/staged_shell_capture_window.ts"],
    ["run-native-temperate-fidelity-capture.mjs", "js/src/demos/temperate_fidelity_capture_window.ts"],
  ].map(([runner, module]) => Object.freeze({ runner: `tools/preview/${runner}`, module })),
);

export const GUARDED_NATIVE_CAPTURE_CONTRACTS = CONTRACTS;
const prepared = new WeakSet(),
  archived = new WeakSet();
const portable = (base, path) => relative(base, path).split(sep).join("/");
const inside = (base, path) => {
  const value = relative(base, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

function contractFor(repoRoot, runnerUrl, modulePath) {
  if (typeof runnerUrl !== "string" || !runnerUrl.startsWith("file:"))
    throw new Error("guarded capture runner must identify itself with import.meta.url");
  const runner = portable(repoRoot, fileURLToPath(runnerUrl));
  const contract = CONTRACTS.find((entry) => entry.runner === runner);
  if (contract === undefined || contract.module !== modulePath)
    throw new Error(`guarded capture runner is outside the exact source contract: ${runner} -> ${modulePath}`);
  return contract;
}

function exactRuntimePath(runtimeBinary) {
  if (
    typeof runtimeBinary !== "string" ||
    !runtimeBinary ||
    isAbsolute(runtimeBinary) ||
    runtimeBinary.includes("\\") ||
    runtimeBinary.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error(`guarded capture runtime must be an exact workspace-relative path: ${runtimeBinary}`);
  return runtimeBinary;
}

/** Build the exact producer closure before delegating the native process to the Xid guard. */
export async function runGuardedCaptureWithSourceClosure(spec, dependencies = {}) {
  const repoRoot = await realpath(resolve(spec?.repoRoot ?? root)),
    contract = contractFor(repoRoot, spec?.runnerUrl, spec?.modulePath),
    runtimeBinary = exactRuntimePath(spec?.runtimeBinary ?? "target/release/limina"),
    runtimePath = resolve(repoRoot, runtimeBinary),
    command = resolve(spec?.command ?? runtimePath),
    cwd = await realpath(resolve(spec?.cwd ?? repoRoot)),
    args = spec?.args;
  if (!Array.isArray(args) || !args.includes(contract.module))
    throw new Error("guarded capture argv does not contain its contracted engine module");
  if (cwd !== repoRoot || command !== runtimePath)
    throw new Error("guarded capture command or working directory escaped its producer contract");
  const canonicalRuntime = await realpath(runtimePath),
    canonicalCommand = await realpath(command),
    runtimeStat = await lstat(canonicalRuntime);
  if (
    !inside(repoRoot, canonicalRuntime) ||
    !inside(repoRoot, canonicalCommand) ||
    canonicalCommand !== canonicalRuntime ||
    !runtimeStat.isFile()
  )
    throw new Error("guarded capture runtime real path escaped its canonical workspace");
  const buildClosure = dependencies.buildClosure ?? buildCaptureProducerClosure,
    runGuard = dependencies.runGuard ?? runNativeCaptureWithXidGuard,
    execution = await buildClosure({
      repoRoot,
      entryPaths: [contract.runner, contract.module],
      runtimeBinary,
      argv: [runtimeBinary, ...args],
      environmentKeys: Object.keys(spec?.environment ?? process.env),
    }),
    guardEvidence = await runGuard({
      command,
      args,
      cwd,
      environment: spec?.environment,
      failureLabel: spec?.failureLabel,
    }),
    capture = Object.freeze({
      schema: GUARDED_CAPTURE_PUBLICATION_SCHEMA,
      execution,
      guardEvidence,
      repoRoot,
    });
  prepared.add(capture);
  return capture;
}

/** Create and verify the immutable source archive before any capture artifact is published. */
export async function archiveGuardedCaptureSources({ capture, evidenceRoot }, dependencies = {}) {
  if (!prepared.has(capture) || archived.has(capture))
    throw new Error("capture source archive requires one fresh guarded producer session");
  const outputRoot = resolve(evidenceRoot),
    canonicalRepo = await realpath(capture.repoRoot),
    parent = await realpath(dirname(outputRoot));
  if (!inside(canonicalRepo, outputRoot) || !inside(canonicalRepo, parent))
    throw new Error("capture evidence directory escaped the private workspace");
  const evidenceStat = await lstat(outputRoot);
  if (
    !evidenceStat.isDirectory() ||
    evidenceStat.isSymbolicLink() ||
    (evidenceStat.mode & 0o077) !== 0 ||
    (await realpath(outputRoot)) !== outputRoot
  )
    throw new Error("capture evidence root must be a real private directory");
  const writeArchive = dependencies.writeArchive ?? writeCaptureSourceArchive,
    verifyArchive = dependencies.verifyArchive ?? verifyCaptureSourceArchive,
    sourceArchive = await writeArchive({
      repoRoot: capture.repoRoot,
      outputRoot,
      sources: capture.execution.sources,
    });
  await verifyArchive({ evidenceRoot: outputRoot, record: sourceArchive, expectedSources: capture.execution.sources });
  archived.add(capture);
  return Object.freeze({
    captureProducer: capture.execution,
    guardEvidence: capture.guardEvidence,
    sourceArchive,
  });
}

/** Re-verify that evidence contains the exact archive identity before writing the evidence file. */
export async function verifyGuardedCaptureEvidence({ capture, evidenceRoot, evidence }, dependencies = {}) {
  if (!archived.has(capture)) throw new Error("capture evidence cannot precede its verified source archive");
  if (
    evidence?.captureProducer !== capture.execution ||
    evidence?.guardEvidence !== capture.guardEvidence ||
    evidence?.sourceArchive === undefined
  )
    throw new Error("capture evidence omitted or replaced the guarded producer archive identity");
  const verifyArchive = dependencies.verifyArchive ?? verifyCaptureSourceArchive;
  await verifyArchive({
    evidenceRoot: resolve(evidenceRoot),
    record: evidence.sourceArchive,
    expectedSources: capture.execution.sources,
  });
  return evidence;
}
