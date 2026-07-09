const TRANSACTION_SCHEMA = "limina.authoring-transaction/v1";
const HEAD_SCHEMA = "limina.world-project-head/v1";
const RECEIPT_SCHEMA = "limina.authoring-receipt/v1";
const SCENE_ADAPTER = "scene";
const SCENE_ADAPTER_VERSION = "1.0.0";
const DEFAULT_HISTORY_LIMIT = 128;
const MAX_TRANSACTION_ID_LENGTH = 128;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_COORDINATE = 1_000_000;
const MAX_SCALE = 10_000;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

function assertEntity(entity) {
  if (typeof entity !== "string" || entity.length > 128 || !ENTITY_ID.test(entity)) {
    throw new TypeError("a valid entity id is required");
  }
}

function assertVector(value, length, name, predicate = () => true) {
  if (!Array.isArray(value) || value.length !== length || !value.every((component) => Number.isFinite(component) && predicate(component))) {
    throw new TypeError(`${name} must contain ${length} finite numbers`);
  }
}

function sceneOperation(action, input) {
  return { adapter: SCENE_ADAPTER, adapterVersion: SCENE_ADAPTER_VERSION, action, input };
}

export function sceneTransformOperation(entity, transform) {
  assertEntity(entity);
  const input = { entity };
  if (transform.position !== undefined) {
    assertVector(transform.position, 3, "position", (component) => Math.abs(component) <= MAX_COORDINATE);
    input.position = [...transform.position];
  }
  if (transform.rotation !== undefined) {
    assertVector(transform.rotation, 4, "rotation", (component) => component >= -1 && component <= 1);
    const magnitudeSquared = transform.rotation.reduce((sum, component) => sum + component * component, 0);
    if (Math.abs(magnitudeSquared - 1) > 1e-4) throw new TypeError("rotation must be a normalized quaternion");
    input.rotation = [...transform.rotation];
  }
  if (transform.scale !== undefined) {
    assertVector(transform.scale, 3, "scale", (component) => component > 0 && component <= MAX_SCALE);
    input.scale = [...transform.scale];
  }
  if (Object.keys(input).length === 1) throw new TypeError("transform.set requires at least one transform field");
  return sceneOperation("transform.set", input);
}

export function sceneTagsOperation(entity, tags) {
  assertEntity(entity);
  if (!Array.isArray(tags) || tags.length > 64 ||
      !tags.every((tag) => typeof tag === "string" && tag.length <= 64 && TAG.test(tag))) {
    throw new TypeError("tags.replace requires at most 64 valid tags");
  }
  if (new Set(tags).size !== tags.length) throw new TypeError("tags.replace does not allow duplicate tags");
  return sceneOperation("tags.replace", { entity, tags: [...tags] });
}

export function sceneMaterialOperation(entity, patch) {
  assertEntity(entity);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("material patch must be an object");
  const allowed = ["color", "roughness", "metalness", "castShadow", "receiveShadow"];
  const input = { entity };
  for (const key of allowed) {
    if (patch[key] !== undefined) input[key] = patch[key];
  }
  if (input.color !== undefined && (!Number.isInteger(input.color) || input.color < 0 || input.color > 0xffffff)) {
    throw new TypeError("material color must be an integer from 0 to 0xffffff");
  }
  for (const key of ["roughness", "metalness"]) {
    if (input[key] !== undefined && (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1)) {
      throw new TypeError(`${key} must be a finite number from 0 to 1`);
    }
  }
  for (const key of ["castShadow", "receiveShadow"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new TypeError(`${key} must be boolean`);
  }
  if (Object.keys(input).length === 1) throw new TypeError("material.patch requires at least one material field");
  return sceneOperation("material.patch", input);
}

function secureRandomBytes(size) {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error("secure randomness is unavailable; refusing to create an authoring transaction id");
  }
  return crypto.getRandomValues(new Uint8Array(size));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateHead(head) {
  if (head?.schema !== HEAD_SCHEMA || typeof head.projectId !== "string" || head.projectId.length > 64 ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(head.projectId) ||
      !Number.isSafeInteger(head.revision) || head.revision < 0 ||
      typeof head.headHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(head.headHash)) {
    throw new Error("authoring.head returned an invalid project head");
  }
  return { schema: head.schema, projectId: head.projectId, revision: head.revision, headHash: head.headHash };
}

function isContentHash(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateCommitResult(result, transaction) {
  if (result?.committed !== true) throw new Error("authoring.commit did not confirm a new committed transaction");
  const receipt = result.receipt;
  const expectedCompensation = transaction.compensates?.transactionId;
  if (receipt?.schema !== RECEIPT_SCHEMA || receipt.transactionId !== transaction.transactionId ||
      receipt.projectId !== transaction.projectId || receipt.previousRevision !== transaction.baseRevision ||
      receipt.previousHeadHash !== transaction.baseHeadHash ||
      receipt.committedRevision !== transaction.baseRevision + 1 ||
      !isContentHash(receipt.transactionHash) || !isContentHash(receipt.headHash) ||
      receipt.compensates !== expectedCompensation || !Array.isArray(receipt.operations) || receipt.operations.length > 256) {
    throw new Error("authoring.commit returned a receipt inconsistent with the submitted transaction");
  }
  const seenIndices = new Set();
  for (const operation of receipt.operations) {
    if (!Number.isInteger(operation?.index) || operation.index < 0 || operation.index > 255 || seenIndices.has(operation.index) ||
        typeof operation.adapter !== "string" || typeof operation.action !== "string" ||
        typeof operation.stateKey !== "string" || operation.stateKey.length < 1 || operation.stateKey.length > 256 ||
        !isContentHash(operation.beforeStateHash) || !isContentHash(operation.afterStateHash)) {
      throw new Error("authoring.commit returned malformed operation receipt evidence");
    }
    seenIndices.add(operation.index);
  }
  if (expectedCompensation === undefined) {
    if (receipt.operations.length !== transaction.operations.length) {
      throw new Error("authoring.commit operation receipt count does not match the transaction");
    }
    for (let index = 0; index < transaction.operations.length; index++) {
      const evidence = receipt.operations[index];
      const submitted = transaction.operations[index];
      if (evidence.index !== index || evidence.adapter !== submitted.adapter || evidence.action !== submitted.action) {
        throw new Error("authoring.commit operation receipt does not match the transaction");
      }
    }
  }
  const record = result.commitRecord;
  if (record?.schema !== "limina.authoring-commit-record/v1" ||
      !(record.previousRecordHash === null || isContentHash(record.previousRecordHash)) ||
      !isContentHash(record.recordHash) || !sameJson(record.receipt, receipt)) {
    throw new Error("authoring.commit returned invalid durable commit evidence");
  }
  return receipt;
}

function receiptSummary(receipt) {
  return Object.freeze({
    transactionId: receipt.transactionId,
    projectId: receipt.projectId,
    committedRevision: receipt.committedRevision,
    headHash: receipt.headHash,
    ...(receipt.compensates === undefined ? {} : { compensates: receipt.compensates }),
  });
}

function isConflict(error) {
  return error?.code === -32009 || error?.data?.error?.code === "conflict" || error?.data?.code === "conflict";
}

export class ProjectAuthoringGateway {
  constructor({ getClient, historyLimit = DEFAULT_HISTORY_LIMIT, randomBytes = secureRandomBytes } = {}) {
    if (typeof getClient !== "function") throw new TypeError("getClient is required");
    if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError("historyLimit must be a positive integer");
    this.getClient = getClient;
    this.historyLimit = historyLimit;
    const nonceBytes = randomBytes(16);
    if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 16) {
      throw new Error("randomBytes must return exactly 16 bytes");
    }
    this.nonce = bytesToHex(nonceBytes);
    this.counter = 0n;
    this.head = undefined;
    this.headClient = undefined;
    this.undoStack = [];
    this.redoStack = [];
    this.queueTail = Promise.resolve();
  }

  invalidateHead() {
    this.head = undefined;
    this.headClient = undefined;
  }

  historySnapshot() {
    const summarize = (entry) => ({
      transactionId: entry.transactionId,
      operations: cloneJson(entry.operations),
      receipt: { ...entry.receipt },
    });
    return {
      undo: this.undoStack.map(summarize),
      redo: this.redoStack.map(summarize),
      head: this.head ? { ...this.head } : undefined,
    };
  }

  refreshHead() {
    return this.#enqueue(async () => {
      const client = await this.getClient();
      return this.#refreshHeadWith(client);
    });
  }

  commit(operations) {
    const copied = this.#validateOperations(operations);
    return this.#enqueue(async () => {
      const entry = await this.#commitOperations(copied);
      this.#pushBounded(this.undoStack, entry);
      this.redoStack.length = 0;
      return entry.receipt;
    });
  }

  undo() {
    return this.#enqueue(async () => {
      const target = this.undoStack.at(-1);
      if (!target) return undefined;
      const receipt = await this.#commitTransaction([], target.transactionId);
      this.undoStack.pop();
      this.#pushBounded(this.redoStack, target);
      return receiptSummary(receipt);
    });
  }

  redo() {
    return this.#enqueue(async () => {
      const target = this.redoStack.at(-1);
      if (!target) return undefined;
      const entry = await this.#commitOperations(target.operations);
      this.redoStack.pop();
      this.#pushBounded(this.undoStack, entry);
      return entry.receipt;
    });
  }

  #enqueue(work) {
    const run = this.queueTail.then(work, work);
    this.queueTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #nextTransactionId() {
    this.counter += 1n;
    const id = `edt.${this.nonce}.${this.counter.toString(36)}`;
    if (id.length > MAX_TRANSACTION_ID_LENGTH) throw new Error("authoring transaction id exceeded the protocol limit");
    return id;
  }

  #validateOperations(operations) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 256) {
      throw new TypeError("an authoring transaction requires 1 to 256 operations");
    }
    const copied = cloneJson(operations);
    for (const operation of copied) {
      if (operation?.adapter !== SCENE_ADAPTER || operation.adapterVersion !== SCENE_ADAPTER_VERSION) {
        throw new TypeError("the editor gateway only accepts scene adapter 1.0.0 operations");
      }
      let validated;
      if (operation.action === "transform.set") validated = sceneTransformOperation(operation.input?.entity, operation.input ?? {});
      else if (operation.action === "tags.replace") validated = sceneTagsOperation(operation.input?.entity, operation.input?.tags);
      else if (operation.action === "material.patch") {
        const { entity, ...patch } = operation.input ?? {};
        validated = sceneMaterialOperation(entity, patch);
      } else {
        throw new TypeError(`unsupported scene adapter action: ${String(operation.action)}`);
      }
      if (!sameJson(validated, operation)) {
        throw new TypeError("scene operation contains unsupported or non-canonical fields");
      }
    }
    return copied;
  }

  async #refreshHeadWith(client) {
    const head = validateHead(await client.callTool("authoring.head", {}));
    this.head = head;
    this.headClient = client;
    return { ...head };
  }

  async #currentHead(client) {
    if (!this.head || this.headClient !== client) return this.#refreshHeadWith(client);
    return this.head;
  }

  async #commitOperations(operations) {
    const receipt = await this.#commitTransaction(operations);
    return Object.freeze({
      transactionId: receipt.transactionId,
      operations: cloneJson(operations),
      receipt: receiptSummary(receipt),
    });
  }

  async #commitTransaction(operations, compensates) {
    const client = await this.getClient();
    const head = await this.#currentHead(client);
    const transaction = {
      schema: TRANSACTION_SCHEMA,
      transactionId: this.#nextTransactionId(),
      projectId: head.projectId,
      baseRevision: head.revision,
      baseHeadHash: head.headHash,
      operations: cloneJson(operations),
      ...(compensates === undefined ? {} : { compensates: { transactionId: compensates } }),
    };
    try {
      const result = await client.callTool("authoring.commit", { transaction });
      const receipt = validateCommitResult(result, transaction);
      this.head = {
        schema: HEAD_SCHEMA,
        projectId: receipt.projectId,
        revision: receipt.committedRevision,
        headHash: receipt.headHash,
      };
      this.headClient = client;
      return receipt;
    } catch (error) {
      if (isConflict(error)) {
        this.invalidateHead();
        try { await this.#refreshHeadWith(client); } catch { this.invalidateHead(); }
      } else this.invalidateHead();
      throw error;
    }
  }

  #pushBounded(stack, entry) {
    stack.push(entry);
    if (stack.length > this.historyLimit) stack.splice(0, stack.length - this.historyLimit);
  }
}
