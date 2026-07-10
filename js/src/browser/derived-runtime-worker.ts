import {
  DerivedRuntimeTransport,
  DerivedRuntimeTransportError,
  type DerivedArtifactDescriptor,
  type DerivedRuntimeCurrent,
  type DerivedRuntimeTransportConfig,
} from "./derived-runtime-transport.ts";
import { DerivedRevisionManager, DerivedRevisionRuntimeError } from "../world/derived-runtime.mjs";
import {
  TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
  decodeTerrainChunkArtifact,
} from "../world/compiler/terrain-artifact.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  decodeHydrologyFieldArtifact,
} from "../world/hydrology-artifact.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  inspectHydrologyWaterArtifactBindings,
} from "../world/hydrology-water-artifact.mjs";
import { prepareGeneratedWaterFieldInput } from "../world/water-field.mjs";
import {
  WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  decodeWorldOverviewArtifact,
} from "../world/compiler/world-overview-artifact.mjs";
import {
  NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  decodeNavigationIndexArtifact,
} from "../world/compiler/navigation-index-artifact.mjs";
import {
  derivedTerrainResidencyKey,
  parseDerivedTerrainResidency,
  selectDerivedTerrainChunks,
  type DerivedTerrainResidency,
} from "./derived-terrain-residency.ts";

export const DERIVED_RUNTIME_WORKER_SCHEMA = "limina.derived-runtime-worker/v4";
export const DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA = "limina.derived-runtime-resource-snapshot/v2";
export const DERIVED_RUNTIME_POLL_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 4_000, 8_000] as const);
export const DERIVED_RUNTIME_ACTIVATION_ACK_TIMEOUT_MS = 15_000;

const HASH = /^sha256:[0-9a-f]{64}$/;
const TERRAIN_CHUNK_ARTIFACT_TYPE = "terrain-chunk/v1";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVATION_ID = /^derived-activation-[1-9][0-9]{0,15}$/;
const MAX_WORKER_ERROR_MESSAGE_LENGTH = 512;

export type DerivedRuntimeWorkerMode = "watch" | "pinned";

export interface DerivedRuntimePinnedSource {
  revision: number;
  headHash: string;
  manifestHash?: string;
}

export interface DerivedRuntimeWorkerInitMessage {
  schema: typeof DERIVED_RUNTIME_WORKER_SCHEMA;
  type: "init";
  requestId: string;
  config: DerivedRuntimeTransportConfig;
  mode: DerivedRuntimeWorkerMode;
  pinnedSource?: DerivedRuntimePinnedSource;
  residency: DerivedTerrainResidency;
}

export interface DerivedRuntimeWorkerActivationAckMessage {
  schema: typeof DERIVED_RUNTIME_WORKER_SCHEMA;
  type: "activation-ack";
  activationId: string;
  requestId?: string;
  accepted: boolean;
  errorCode?: string;
}

export interface DerivedRuntimeWorkerSetResidencyMessage {
  schema: typeof DERIVED_RUNTIME_WORKER_SCHEMA;
  type: "set-residency";
  requestId: string;
  residency: DerivedTerrainResidency;
}

export interface DerivedRuntimeWorkerReconcileResidencyMessage {
  schema: typeof DERIVED_RUNTIME_WORKER_SCHEMA;
  type: "reconcile-residency";
  requestId: string;
  residency: DerivedTerrainResidency;
}

export interface DerivedRuntimeWorkerCloseMessage {
  schema: typeof DERIVED_RUNTIME_WORKER_SCHEMA;
  type: "close";
  requestId: string;
}

export type DerivedRuntimeWorkerInput =
  | DerivedRuntimeWorkerInitMessage
  | DerivedRuntimeWorkerSetResidencyMessage
  | DerivedRuntimeWorkerReconcileResidencyMessage
  | DerivedRuntimeWorkerActivationAckMessage
  | DerivedRuntimeWorkerCloseMessage;

export interface DerivedRuntimeWorkerPost {
  (message: unknown, transfer?: Transferable[]): void;
}

interface TimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface RuntimeTransport {
  fetchCurrent(options?: Readonly<{ previous?: DerivedRuntimeCurrent; signal?: AbortSignal }>): Promise<Readonly<{
    status: "current" | "not-modified";
    current: DerivedRuntimeCurrent;
  }>>;
  fetchArtifact(
    current: DerivedRuntimeCurrent,
    descriptor: DerivedArtifactDescriptor,
    options?: Readonly<{ signal?: AbortSignal; allowNotModified?: boolean }>,
  ): Promise<Readonly<
    { status: "artifact"; contentHash: string; bytes: Uint8Array }
    | { status: "not-modified"; contentHash: string }
  >>;
}

export interface DerivedRuntimeWorkerDependencies {
  postMessage: DerivedRuntimeWorkerPost;
  createTransport?: (config: DerivedRuntimeTransportConfig) => RuntimeTransport;
  timers?: TimerApi;
  activationAckTimeoutMs?: number;
}

interface PendingActivation {
  readonly activationId: string;
  readonly requestId?: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: unknown;
}

interface PendingResidency {
  readonly kind: "set" | "reconcile";
  readonly requestId: string;
  readonly residency: Readonly<DerivedTerrainResidency>;
}

interface HydrologyWaterBindings {
  readonly hydrologyFieldContentHash: string;
  readonly recipeHash: string;
  readonly erosionStageKey: string;
  readonly compilerGraphHash: string;
}

export class DerivedRuntimeWorkerError extends Error {
  readonly code: string;
  readonly classification: "transient" | "fatal";

  constructor(code: string, classification: "transient" | "fatal", message: string) {
    super(message);
    this.name = "DerivedRuntimeWorkerError";
    this.code = code;
    this.classification = classification;
  }
}

function fatal(code: string, message: string): DerivedRuntimeWorkerError {
  return new DerivedRuntimeWorkerError(code, "fatal", message);
}

function transient(code: string, message: string): DerivedRuntimeWorkerError {
  return new DerivedRuntimeWorkerError(code, "transient", message);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw fatal("INVALID_MESSAGE", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactDataKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || required.some((key) => !names.includes(key))
      || names.some((key) => !allowed.has(key))) {
    throw fatal("INVALID_MESSAGE", `${label} has unsupported or missing fields`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw fatal("INVALID_MESSAGE", `${label}.${name} must be an enumerable data field`);
    }
  }
}

function requestId(value: unknown, label: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw fatal("INVALID_MESSAGE", `${label} is invalid`);
  return value;
}

function parsePinnedSource(value: unknown): Readonly<DerivedRuntimePinnedSource> {
  const record = plainRecord(value, "derived runtime pinnedSource");
  exactDataKeys(record, ["revision", "headHash"], ["manifestHash"], "derived runtime pinnedSource");
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0
      || typeof record.headHash !== "string" || !HASH.test(record.headHash)
      || (record.manifestHash !== undefined && (typeof record.manifestHash !== "string" || !HASH.test(record.manifestHash)))) {
    throw fatal("INVALID_MESSAGE", "derived runtime pinnedSource is invalid");
  }
  return Object.freeze({
    revision: record.revision as number,
    headHash: record.headHash,
    ...(record.manifestHash === undefined ? {} : { manifestHash: record.manifestHash }),
  });
}

function parseInit(value: Record<string, unknown>): Readonly<DerivedRuntimeWorkerInitMessage> {
  exactDataKeys(value, ["schema", "type", "requestId", "config", "mode", "residency"], ["pinnedSource"], "derived runtime init");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "init") throw fatal("INVALID_MESSAGE", "derived runtime init schema/type is invalid");
  const mode = value.mode;
  if (mode !== "watch" && mode !== "pinned") throw fatal("INVALID_MESSAGE", "derived runtime init mode must be watch or pinned");
  const configRecord = plainRecord(value.config, "derived runtime init config");
  exactDataKeys(configRecord, ["baseUrl", "token", "projectId", "branchId"], [], "derived runtime init config");
  const config = configRecord as unknown as DerivedRuntimeTransportConfig;
  const pinnedSource = value.pinnedSource === undefined ? undefined : parsePinnedSource(value.pinnedSource);
  let residency: Readonly<DerivedTerrainResidency>;
  try { residency = parseDerivedTerrainResidency(value.residency); }
  catch (error) { throw fatal("INVALID_MESSAGE", error instanceof Error ? error.message : "derived runtime residency is invalid"); }
  if ((mode === "pinned") !== (pinnedSource !== undefined)) {
    throw fatal("INVALID_MESSAGE", "pinned mode requires pinnedSource and watch mode forbids it");
  }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "init",
    requestId: requestId(value.requestId, "derived runtime init requestId"),
    config,
    mode,
    ...(pinnedSource === undefined ? {} : { pinnedSource }),
    residency,
  });
}

function parseAck(value: Record<string, unknown>): Readonly<DerivedRuntimeWorkerActivationAckMessage> {
  exactDataKeys(value, ["schema", "type", "activationId", "accepted"], ["requestId", "errorCode"], "derived runtime activation ack");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "activation-ack"
      || typeof value.activationId !== "string" || !ACTIVATION_ID.test(value.activationId)
      || typeof value.accepted !== "boolean") {
    throw fatal("INVALID_MESSAGE", "derived runtime activation ack is invalid");
  }
  if ((value.accepted === true && value.errorCode !== undefined)
      || (value.accepted === false && (typeof value.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode)))) {
    throw fatal("INVALID_MESSAGE", "derived runtime activation ack errorCode is invalid");
  }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: value.activationId,
    ...(value.requestId === undefined ? {} : { requestId: requestId(value.requestId, "derived runtime activation ack requestId") }),
    accepted: value.accepted,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as string }),
  });
}

function parseSetResidency(value: Record<string, unknown>): Readonly<DerivedRuntimeWorkerSetResidencyMessage> {
  exactDataKeys(value, ["schema", "type", "requestId", "residency"], [], "derived runtime set-residency");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "set-residency") {
    throw fatal("INVALID_MESSAGE", "derived runtime set-residency schema/type is invalid");
  }
  let residency: Readonly<DerivedTerrainResidency>;
  try { residency = parseDerivedTerrainResidency(value.residency); }
  catch (error) { throw fatal("INVALID_MESSAGE", error instanceof Error ? error.message : "derived runtime residency is invalid"); }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "set-residency",
    requestId: requestId(value.requestId, "derived runtime set-residency requestId"),
    residency,
  });
}

function parseReconcileResidency(value: Record<string, unknown>): Readonly<DerivedRuntimeWorkerReconcileResidencyMessage> {
  exactDataKeys(value, ["schema", "type", "requestId", "residency"], [], "derived runtime reconcile-residency");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "reconcile-residency") {
    throw fatal("INVALID_MESSAGE", "derived runtime reconcile-residency schema/type is invalid");
  }
  let residency: Readonly<DerivedTerrainResidency>;
  try { residency = parseDerivedTerrainResidency(value.residency); }
  catch (error) { throw fatal("INVALID_MESSAGE", error instanceof Error ? error.message : "derived runtime residency is invalid"); }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "reconcile-residency",
    requestId: requestId(value.requestId, "derived runtime reconcile-residency requestId"),
    residency,
  });
}

function parseClose(value: Record<string, unknown>): Readonly<DerivedRuntimeWorkerCloseMessage> {
  exactDataKeys(value, ["schema", "type", "requestId"], [], "derived runtime close");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "close") throw fatal("INVALID_MESSAGE", "derived runtime close schema/type is invalid");
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "close",
    requestId: requestId(value.requestId, "derived runtime close requestId"),
  });
}

export function parseDerivedRuntimeWorkerInput(value: unknown): Readonly<DerivedRuntimeWorkerInput> {
  const record = plainRecord(value, "derived runtime worker message");
  const type = Object.getOwnPropertyDescriptor(record, "type")?.value;
  if (type === "init") return parseInit(record);
  if (type === "set-residency") return parseSetResidency(record);
  if (type === "reconcile-residency") return parseReconcileResidency(record);
  if (type === "activation-ack") return parseAck(record);
  if (type === "close") return parseClose(record);
  throw fatal("INVALID_MESSAGE", "derived runtime worker message type is unsupported");
}

function validateDescriptor(descriptor: DerivedArtifactDescriptor, artifactType: string, mediaType: string, label: string): void {
  if (descriptor.artifactType !== artifactType || descriptor.mediaType !== mediaType) {
    throw fatal("ARTIFACT_CONTRACT_MISMATCH", `${label} descriptor type or media type is invalid`);
  }
}

function shortError(error: unknown): { code: string; classification: "transient" | "fatal"; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.length <= MAX_WORKER_ERROR_MESSAGE_LENGTH
    ? rawMessage
    : `${rawMessage.slice(0, MAX_WORKER_ERROR_MESSAGE_LENGTH - 3)}...`;
  if (error instanceof DerivedRuntimeWorkerError || error instanceof DerivedRuntimeTransportError) {
    return { code: error.code, classification: error.classification, message };
  }
  if (error instanceof DerivedRevisionRuntimeError) {
    const transientCodes = new Set(["STALE_SOURCE_HEAD", "DERIVED_REVISION_CANCELLED"]);
    return { code: error.code, classification: transientCodes.has(error.code) ? "transient" : "fatal", message };
  }
  if (error instanceof RangeError && error.message === "derived terrain residency contains no manifest chunks") {
    return { code: "RESIDENCY_OUTSIDE_DOMAIN", classification: "transient", message };
  }
  return { code: "INTERNAL_ERROR", classification: "fatal", message };
}

function cloneForTransfer(value: unknown, transfers: Transferable[], seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw fatal("RESOURCE_NOT_SERIALIZABLE", "derived runtime resource contains unsupported data");
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    transfers.push(copy);
    seen.set(value, copy);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const copyBuffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      transfers.push(copyBuffer);
      const copy = new DataView(copyBuffer);
      seen.set(value, copy);
      return copy;
    }
    const source = value as Exclude<ArrayBufferView, DataView>;
    const Constructor = source.constructor as { new (source: ArrayLike<number>): Exclude<ArrayBufferView, DataView> };
    const copy = new Constructor(source as unknown as ArrayLike<number>);
    transfers.push(copy.buffer as ArrayBuffer);
    seen.set(value, copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(cloneForTransfer(entry, transfers, seen));
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, entry] of value) copy.set(cloneForTransfer(key, transfers, seen), cloneForTransfer(entry, transfers, seen));
    return copy;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw fatal("RESOURCE_NOT_SERIALIZABLE", "derived runtime resource contains a non-plain object");
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw fatal("RESOURCE_NOT_SERIALIZABLE", `derived runtime resource field '${key}' is not plain data`);
    }
    copy[key] = cloneForTransfer(descriptor.value, transfers, seen);
  }
  return copy;
}

function sourceMatches(source: Readonly<{ revision: number; headHash: string }>, pinned: DerivedRuntimePinnedSource): boolean {
  return source.revision === pinned.revision && source.headHash === pinned.headHash;
}

export class DerivedRuntimeWorkerController {
  readonly #postMessage: DerivedRuntimeWorkerPost;
  readonly #createTransport: (config: DerivedRuntimeTransportConfig) => RuntimeTransport;
  readonly #timers: TimerApi;
  readonly #ackTimeoutMs: number;
  readonly #lifecycle = new AbortController();
  #transport: RuntimeTransport | null = null;
  #manager: DerivedRevisionManager | null = null;
  #projectId = "";
  #branchId = "";
  #mode: DerivedRuntimeWorkerMode | null = null;
  #pinnedSource: Readonly<DerivedRuntimePinnedSource> | null = null;
  #pinnedManifestHash: string | null = null;
  #desiredResidency!: Readonly<DerivedTerrainResidency>;
  #submissionResidency: Readonly<DerivedTerrainResidency> | null = null;
  #appliedResidencyKey: string | null = null;
  #pendingResidency: PendingResidency | null = null;
  #activeReconcileRequestId: string | null = null;
  #submissionReconcileRequestId: string | null = null;
  #observed: DerivedRuntimeCurrent | undefined;
  #submissionCurrent: DerivedRuntimeCurrent | null = null;
  #pollTimer: unknown = null;
  #pollTimerExplicit = false;
  #polling = false;
  #backoffIndex = 0;
  #activationSequence = 0;
  #pendingActivation: PendingActivation | null = null;
  #initialized = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(dependencies: DerivedRuntimeWorkerDependencies) {
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new TypeError("derived runtime worker dependencies must be an object");
    }
    if (typeof dependencies.postMessage !== "function") throw new TypeError("derived runtime worker postMessage must be a function");
    this.#postMessage = dependencies.postMessage;
    this.#createTransport = dependencies.createTransport ?? ((config) => new DerivedRuntimeTransport(config));
    this.#timers = dependencies.timers ?? {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.#ackTimeoutMs = dependencies.activationAckTimeoutMs ?? DERIVED_RUNTIME_ACTIVATION_ACK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#ackTimeoutMs) || this.#ackTimeoutMs < 100 || this.#ackTimeoutMs > 120_000) {
      throw new RangeError("derived runtime worker activationAckTimeoutMs must be an integer in [100, 120000]");
    }
  }

  get isInitialized(): boolean { return this.#initialized; }
  get isClosed(): boolean { return this.#closed; }
  get isPolling(): boolean { return this.#polling; }

  async handleMessage(input: unknown): Promise<void> {
    let message: Readonly<DerivedRuntimeWorkerInput>;
    try {
      message = parseDerivedRuntimeWorkerInput(input);
      if (message.type === "init") {
        this.#initialize(message);
        return;
      }
      if (message.type === "set-residency") {
        this.#setResidency(message, "set");
        return;
      }
      if (message.type === "reconcile-residency") {
        this.#setResidency(message, "reconcile");
        return;
      }
      if (message.type === "activation-ack") {
        this.#acknowledge(message);
        return;
      }
      await this.close(message.requestId);
    } catch (error) {
      this.#emitError(error);
    }
  }

  #initialize(message: Readonly<DerivedRuntimeWorkerInitMessage>): void {
    if (this.#closed) throw fatal("DERIVED_RUNTIME_CLOSED", "derived runtime worker is closed");
    if (this.#initialized) throw fatal("ALREADY_INITIALIZED", "derived runtime worker is already initialized");
    const transport = this.#createTransport(message.config);
    this.#projectId = message.config.projectId;
    this.#branchId = message.config.branchId;
    this.#mode = message.mode;
    this.#pinnedSource = message.pinnedSource ?? null;
    this.#pinnedManifestHash = message.pinnedSource?.manifestHash ?? null;
    this.#desiredResidency = message.residency;
    this.#transport = transport;
    this.#manager = new DerivedRevisionManager({
      projectId: this.#projectId,
      branchId: this.#branchId,
      getAuthoritativeSource: () => this.#getAuthoritativeSource(),
      loadArtifact: (input: { manifest: { manifestHash: string }; artifact: DerivedArtifactDescriptor; signal: AbortSignal }) => (
        this.#loadArtifact(input.manifest.manifestHash, input.artifact, input.signal)
      ),
      selectChunks: (manifest: Parameters<typeof selectDerivedTerrainChunks>[0]) => {
        if (this.#submissionResidency === null) {
          throw fatal("NO_SUBMISSION_RESIDENCY", "derived runtime has no residency bound to the active submission");
        }
        return selectDerivedTerrainChunks(manifest, this.#submissionResidency);
      },
      stageChunk: (input: { artifacts: ReadonlyArray<{ artifact: DerivedArtifactDescriptor; bytes: Uint8Array }>; signal: AbortSignal }) => (
        this.#stageChunk(input.artifacts, input.signal)
      ),
      stageGlobal: (input: {
        manifest: { compiler: { graphHash: string } };
        artifact: DerivedArtifactDescriptor;
        bytes: Uint8Array;
        dependencies: ReadonlyMap<string, { artifact: DerivedArtifactDescriptor; resource: unknown }>;
        signal: AbortSignal;
      }) => this.#stageGlobal(input),
      activateRevision: (input: unknown) => this.#activate(input),
      disposeChunk: async () => {},
      disposeGlobal: async () => {},
    });
    this.#initialized = true;
    this.#postMessage(Object.freeze({
      schema: DERIVED_RUNTIME_WORKER_SCHEMA,
      type: "ready",
      requestId: message.requestId,
      mode: message.mode,
    }));
    this.#schedulePoll(0, true);
  }

  #setResidency(message: Readonly<DerivedRuntimeWorkerSetResidencyMessage | DerivedRuntimeWorkerReconcileResidencyMessage>, kind: "set" | "reconcile"): void {
    if (this.#closed) throw fatal("DERIVED_RUNTIME_CLOSED", "derived runtime worker is closed");
    if (!this.#initialized) throw fatal("NOT_INITIALIZED", "derived runtime worker is not initialized");
    if (this.#pendingResidency !== null) {
      throw fatal("RESIDENCY_UPDATE_OVERLAP", "derived runtime already has a residency update awaiting acknowledgement");
    }
    if (derivedTerrainResidencyKey(message.residency) === derivedTerrainResidencyKey(this.#desiredResidency)) {
      if (kind === "set") this.#postResidencyAck(message.requestId, message.residency);
      else {
        this.#pendingResidency = Object.freeze({ kind, requestId: message.requestId, residency: message.residency });
        if (!this.#polling) this.#acceptPendingResidency();
      }
      return;
    }
    this.#pendingResidency = Object.freeze({ kind, requestId: message.requestId, residency: message.residency });
    if (!this.#polling) this.#acceptPendingResidency();
  }

  #postResidencyAck(requestId: string, residency: Readonly<DerivedTerrainResidency>): void {
    this.#postMessage(Object.freeze({
      schema: DERIVED_RUNTIME_WORKER_SCHEMA,
      type: "residency-ack",
      requestId,
      residency,
    }));
  }

  #acceptPendingResidency(): boolean {
    const pending = this.#pendingResidency;
    if (pending === null || this.#closed) return false;
    this.#pendingResidency = null;
    this.#desiredResidency = pending.residency;
    if (pending.kind === "reconcile") this.#activeReconcileRequestId = pending.requestId;
    this.#backoffIndex = 0;
    if (this.#pollTimer !== null) {
      this.#timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
      this.#pollTimerExplicit = false;
    }
    // This acknowledgement is the serialization boundary: no older reconcile is still able to
    // emit an activation, and FIFO worker delivery advances the client's expected residency first.
    if (pending.kind === "set") this.#postResidencyAck(pending.requestId, pending.residency);
    this.#schedulePoll(0, true);
    return true;
  }

  async #getAuthoritativeSource(): Promise<Readonly<{ projectId: string; branchId: string; revision: number; headHash: string }>> {
    const transport = this.#requireTransport();
    const current = this.#submissionCurrent;
    if (current === null) throw fatal("NO_SUBMISSION_PUBLICATION", "derived runtime has no publication bound to the active submission");
    const result = await transport.fetchCurrent({ previous: current, signal: this.#lifecycle.signal });
    this.#observed = result.current;
    if (this.#mode === "pinned" && !sourceMatches(result.current.source, this.#pinnedSource!)) {
      throw fatal("PINNED_SOURCE_MISMATCH", "published source changed during pinned residency activation");
    }
    if (result.current.manifestHash !== current.manifestHash && this.#mode === "pinned") {
      throw fatal("PINNED_MANIFEST_MISMATCH", "published derived manifest changed during pinned residency activation");
    }
    if (result.current.manifestHash !== current.manifestHash
        && result.current.source.revision === current.source.revision
        && result.current.source.headHash === current.source.headHash) {
      throw transient("CURRENT_CHANGED", "published derived manifest changed during residency activation");
    }
    return Object.freeze({
      projectId: this.#projectId,
      branchId: this.#branchId,
      revision: result.current.source.revision,
      headHash: result.current.source.headHash,
    });
  }

  async #loadArtifact(manifestHash: string, descriptor: DerivedArtifactDescriptor, signal: AbortSignal): Promise<Uint8Array> {
    const current = this.#submissionCurrent;
    if (current === null || current.manifestHash !== manifestHash) {
      throw fatal("PUBLICATION_BINDING_MISMATCH", "artifact load is not bound to the submitted publication");
    }
    const result = await this.#requireTransport().fetchArtifact(current, descriptor, { signal });
    if (result.status !== "artifact") throw fatal("PROTOCOL_ERROR", "derived artifact unexpectedly returned not-modified");
    return result.bytes;
  }

  #stageChunk(
    artifacts: ReadonlyArray<{ artifact: DerivedArtifactDescriptor; bytes: Uint8Array }>,
    signal: AbortSignal,
  ): unknown {
    if (signal.aborted) throw signal.reason;
    if (artifacts.length !== 1) throw fatal("UNSUPPORTED_CHUNK_ARTIFACTS", "derived terrain chunk must contain exactly one artifact");
    const payload = artifacts[0];
    validateDescriptor(payload.artifact, TERRAIN_CHUNK_ARTIFACT_TYPE, TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE, "terrain chunk");
    const decoded = decodeTerrainChunkArtifact(payload.bytes);
    if (signal.aborted) throw signal.reason;
    return Object.freeze({ kind: "terrain-chunk/v1", decoded });
  }

  #stageGlobal(input: {
    manifest: { compiler: { graphHash: string } };
    artifact: DerivedArtifactDescriptor;
    bytes: Uint8Array;
    dependencies: ReadonlyMap<string, { artifact: DerivedArtifactDescriptor; resource: unknown }>;
    signal: AbortSignal;
  }): unknown {
    if (input.signal.aborted) throw input.signal.reason;
    if (input.artifact.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, WORLD_OVERVIEW_ARTIFACT_TYPE, WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE, "world overview");
      const decoded = decodeWorldOverviewArtifact(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: WORLD_OVERVIEW_ARTIFACT_TYPE, decoded });
    }
    if (input.artifact.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, NAVIGATION_INDEX_ARTIFACT_TYPE, NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE, "navigation index");
      decodeNavigationIndexArtifact(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: NAVIGATION_INDEX_ARTIFACT_TYPE, bytes: input.bytes });
    }
    if (input.artifact.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, HYDROLOGY_FIELD_ARTIFACT_TYPE, HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE, "hydrology field");
      const decode = decodeHydrologyFieldArtifact as unknown as (
        bytes: Uint8Array,
        control?: Readonly<{ shouldCancel: () => boolean }>,
      ) => unknown;
      const decoded = decode(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: "hydrology-field/v1", decoded });
    }
    if (input.artifact.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, HYDROLOGY_WATER_ARTIFACT_TYPE, HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE, "hydrology water");
      const field = input.dependencies.get(HYDROLOGY_FIELD_ARTIFACT_TYPE);
      if (field === undefined) throw fatal("GLOBAL_DEPENDENCY_MISSING", "hydrology water requires the staged hydrology field");
      const inspectBindings = inspectHydrologyWaterArtifactBindings as unknown as (bytes: Uint8Array) => HydrologyWaterBindings;
      const bindings = inspectBindings(input.bytes);
      if (bindings.hydrologyFieldContentHash !== field.artifact.contentHash) {
        throw fatal("WATER_FIELD_BINDING_MISMATCH", "hydrology water artifact is bound to another hydrology field");
      }
      if (bindings.compilerGraphHash !== input.manifest.compiler.graphHash) {
        throw fatal("WATER_GRAPH_BINDING_MISMATCH", "hydrology water artifact is bound to another compiler graph");
      }
      const prepared = prepareGeneratedWaterFieldInput({
        bytes: input.bytes,
        descriptor: input.artifact,
        expectedBindings: bindings,
      }, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      // The prepared envelope is worker-local branded state. Its decoded topology is safe for
      // render staging after structured clone, but simulation must independently re-verify and
      // re-brand the canonical bytes in the sim worker before gameplay contact can change.
      return Object.freeze({
        kind: "hydrology-water-topology/v1",
        artifact: input.artifact,
        bytes: input.bytes,
        bindings,
        prepared,
      });
    }
    throw fatal("UNSUPPORTED_GLOBAL_ARTIFACT", `derived runtime does not support global artifact '${input.artifact.artifactType}'`);
  }

  async #activate(input: unknown): Promise<void> {
    if (this.#pendingActivation !== null) throw fatal("ACTIVATION_OVERLAP", "derived runtime activation overlapped another acknowledgement");
    const activation = input as {
      manifest: { manifestHash: string; source: { revision: number; headHash: string } };
      chunks: unknown[];
      globals: Map<string, unknown>;
    };
    const transfers: Transferable[] = [];
    const candidate = cloneForTransfer({
      manifest: activation.manifest,
      chunks: activation.chunks,
      globals: [...activation.globals.values()],
    }, transfers) as {
      manifest: { manifestHash: string; source: { revision: number; headHash: string } };
      chunks: unknown[];
      globals: unknown[];
    };
    const activationId = `derived-activation-${++this.#activationSequence}`;
    const residency = this.#submissionResidency;
    if (residency === null) throw fatal("NO_SUBMISSION_RESIDENCY", "derived runtime activation has no bound residency");
    const requestId = this.#submissionReconcileRequestId;
    const snapshot = {
      schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
      projectId: this.#projectId,
      branchId: this.#branchId,
      manifestHash: candidate.manifest.manifestHash,
      source: candidate.manifest.source,
      manifest: candidate.manifest,
      residency,
      chunks: candidate.chunks,
      globals: candidate.globals,
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = this.#timers.setTimeout(() => {
        if (this.#pendingActivation?.activationId !== activationId) return;
        this.#pendingActivation = null;
        reject(transient("ACTIVATION_ACK_TIMEOUT", "derived runtime activation acknowledgement timed out"));
      }, this.#ackTimeoutMs);
      this.#pendingActivation = { activationId, ...(requestId === null ? {} : { requestId }), resolve, reject, timeout };
      try {
        this.#postMessage(Object.freeze({
          schema: DERIVED_RUNTIME_WORKER_SCHEMA,
          type: "activate",
          activationId,
          ...(requestId === null ? {} : { requestId }),
          snapshot,
        }), transfers);
      } catch (error) {
        this.#timers.clearTimeout(timeout);
        this.#pendingActivation = null;
        reject(error instanceof Error ? error : fatal("POST_MESSAGE_FAILED", "derived runtime activation could not be posted"));
      }
    });
  }

  #acknowledge(message: Readonly<DerivedRuntimeWorkerActivationAckMessage>): void {
    if (!this.#initialized) throw fatal("NOT_INITIALIZED", "derived runtime worker is not initialized");
    const pending = this.#pendingActivation;
    if (pending === null || pending.activationId !== message.activationId) {
      throw fatal("UNKNOWN_ACTIVATION", "derived runtime activation acknowledgement is not pending");
    }
    if (pending.requestId !== message.requestId) {
      throw fatal("UNKNOWN_ACTIVATION", "derived runtime activation acknowledgement reconciliation does not match");
    }
    this.#timers.clearTimeout(pending.timeout);
    this.#pendingActivation = null;
    if (message.accepted) pending.resolve();
    else pending.reject(transient("ACTIVATION_REJECTED", `main thread rejected activation (${message.errorCode})`));
  }

  #schedulePoll(delayMs: number, explicit = false): void {
    if (this.#closed || (this.#mode === "pinned" && !explicit)) return;
    if (this.#pollTimer !== null) {
      if (!explicit || this.#pollTimerExplicit) return;
      this.#timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#pollTimerExplicit = explicit;
    this.#pollTimer = this.#timers.setTimeout(() => {
      const wasExplicit = this.#pollTimerExplicit;
      this.#pollTimer = null;
      this.#pollTimerExplicit = false;
      void this.#poll(wasExplicit);
    }, delayMs);
  }

  async #poll(explicit: boolean): Promise<void> {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    const submissionResidency = this.#desiredResidency;
    const submissionResidencyKey = derivedTerrainResidencyKey(submissionResidency);
    const submissionReconcileRequestId = this.#activeReconcileRequestId;
    let canContinue = true;
    try {
      const result = await this.#requireTransport().fetchCurrent({ previous: this.#observed, signal: this.#lifecycle.signal });
      const current = result.current;
      this.#observed = current;
      if (this.#mode === "pinned" && !sourceMatches(current.source, this.#pinnedSource!)) {
        throw fatal(
          "PINNED_SOURCE_MISMATCH",
          `published source ${current.source.revision}/${current.source.headHash} does not match the pinned source`,
        );
      }
      if (this.#mode === "pinned") {
        if (this.#pinnedManifestHash === null) this.#pinnedManifestHash = current.manifestHash;
        else if (current.manifestHash !== this.#pinnedManifestHash) {
          throw fatal("PINNED_MANIFEST_MISMATCH", "published derived manifest does not match the pinned manifest");
        }
      }
      if (result.status === "not-modified"
          && this.#manager!.current?.manifest.manifestHash === current.manifestHash
          && this.#appliedResidencyKey === submissionResidencyKey) {
        this.#backoffIndex = 0;
        this.#postMessage(Object.freeze({
          schema: DERIVED_RUNTIME_WORKER_SCHEMA,
          type: "revision",
          ...(submissionReconcileRequestId === null ? {} : { requestId: submissionReconcileRequestId }),
          status: "unchanged",
          manifestHash: current.manifestHash,
          revision: current.source.revision,
        }));
        if (this.#activeReconcileRequestId === submissionReconcileRequestId) this.#activeReconcileRequestId = null;
        if (this.#mode === "watch") this.#schedulePoll(DERIVED_RUNTIME_POLL_DELAYS_MS[0], false);
        return;
      }
      this.#submissionCurrent = current;
      this.#submissionResidency = submissionResidency;
      this.#submissionReconcileRequestId = submissionReconcileRequestId;
      const submit = this.#manager!.submit as unknown as (
        manifest: unknown,
        options?: Readonly<{ signal: AbortSignal }>,
      ) => Promise<Readonly<{ status: string; manifestHash: string; revision: number }>>;
      const outcome = await submit.call(this.#manager, current.manifest, { signal: this.#lifecycle.signal });
      this.#appliedResidencyKey = submissionResidencyKey;
      this.#submissionCurrent = null;
      this.#submissionResidency = null;
      this.#submissionReconcileRequestId = null;
      this.#backoffIndex = 0;
      this.#postMessage(Object.freeze({
        schema: DERIVED_RUNTIME_WORKER_SCHEMA,
        type: "revision",
        ...(submissionReconcileRequestId === null ? {} : { requestId: submissionReconcileRequestId }),
        status: outcome.status,
        manifestHash: outcome.manifestHash,
        revision: outcome.revision,
      }));
      if (this.#activeReconcileRequestId === submissionReconcileRequestId) this.#activeReconcileRequestId = null;
      if (this.#mode === "watch") this.#schedulePoll(DERIVED_RUNTIME_POLL_DELAYS_MS[0], false);
    } catch (error) {
      this.#submissionCurrent = null;
      this.#submissionResidency = null;
      this.#submissionReconcileRequestId = null;
      if (this.#closed) return;
      const summary = shortError(error);
      this.#emitError(error, submissionReconcileRequestId);
      canContinue = summary.classification !== "fatal";
      if ((summary.classification === "fatal" || summary.code === "RESIDENCY_OUTSIDE_DOMAIN")
          && this.#activeReconcileRequestId === submissionReconcileRequestId) this.#activeReconcileRequestId = null;
      if (summary.classification === "transient" && summary.code !== "RESIDENCY_OUTSIDE_DOMAIN") {
        const delay = DERIVED_RUNTIME_POLL_DELAYS_MS[Math.min(this.#backoffIndex, DERIVED_RUNTIME_POLL_DELAYS_MS.length - 1)];
        this.#backoffIndex = Math.min(this.#backoffIndex + 1, DERIVED_RUNTIME_POLL_DELAYS_MS.length - 1);
        this.#schedulePoll(delay, explicit || this.#mode === "pinned");
      }
    } finally {
      this.#polling = false;
      if (canContinue) this.#acceptPendingResidency();
    }
  }

  #requireTransport(): RuntimeTransport {
    if (this.#transport === null) throw fatal("NOT_INITIALIZED", "derived runtime worker is not initialized");
    return this.#transport;
  }

  #emitError(error: unknown, requestId?: string | null): void {
    const summary = shortError(error);
    this.#postMessage(Object.freeze({
      schema: DERIVED_RUNTIME_WORKER_SCHEMA,
      type: "error",
      ...(requestId === undefined || requestId === null ? {} : { requestId }),
      code: summary.code,
      classification: summary.classification,
      message: summary.message,
    }));
  }

  close(request = "internal-close"): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#lifecycle.abort(fatal("DERIVED_RUNTIME_CLOSED", "derived runtime worker was closed"));
    if (this.#pollTimer !== null) {
      this.#timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#pollTimerExplicit = false;
    this.#pendingResidency = null;
    this.#activeReconcileRequestId = null;
    this.#submissionReconcileRequestId = null;
    const pending = this.#pendingActivation;
    if (pending !== null) {
      this.#timers.clearTimeout(pending.timeout);
      this.#pendingActivation = null;
      pending.reject(fatal("DERIVED_RUNTIME_CLOSED", "derived runtime worker closed during activation"));
    }
    this.#closePromise = (async () => {
      try { await this.#manager?.close(); }
      finally {
        this.#postMessage(Object.freeze({
          schema: DERIVED_RUNTIME_WORKER_SCHEMA,
          type: "closed",
          requestId: request,
        }));
      }
    })();
    return this.#closePromise;
  }
}

export interface DerivedRuntimeWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

export function installDerivedRuntimeWorker(scope: DerivedRuntimeWorkerScope): DerivedRuntimeWorkerController {
  const controller = new DerivedRuntimeWorkerController({
    postMessage: (message, transfer) => scope.postMessage(message, transfer),
  });
  scope.onmessage = (event) => { void controller.handleMessage(event.data); };
  return controller;
}
