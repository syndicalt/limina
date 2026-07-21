/**
 * Persistent content-addressed artifact cache for the derived runtime (cold-connect fix).
 * Keys are sha256 content hashes, so entries are immutable and safe to share across revisions,
 * workers, realms, and page loads. The read path is the trust boundary: every `get` re-hashes
 * the stored bytes with the caller's hash function before they may re-enter the verified
 * pipeline, so a poisoned or torn entry can never masquerade as verified content — it is
 * evicted and the caller falls back to the network. Callers must only `put` bytes that
 * already passed their descriptor hash check (both transports verify before returning);
 * `put` itself does not re-verify, which is also what lets gates seed corrupted entries to
 * prove the read guard. Every operation degrades to a miss: the network is the authority,
 * so a sick cache must cost performance, never correctness or availability.
 */

export const DERIVED_ARTIFACT_CACHE_SCHEMA = 1;
export const DERIVED_ARTIFACT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const DB_NAME = "limina-derived-artifact-cache";
const ARTIFACT_STORE = "artifacts";
const META_STORE = "meta";
const META_KEY = "state";
const SEQ_INDEX = "seq";

export type DerivedArtifactContentHasher = (bytes: Uint8Array) => string;

export interface DerivedArtifactCache {
  /** Verified bytes for the content hash, or undefined on a miss or a failed integrity re-check. */
  get(contentHash: string): Promise<Uint8Array | undefined>;
  /** Store previously verified bytes under their content hash. */
  put(contentHash: string, bytes: Uint8Array): Promise<void>;
}

interface MetaRecord {
  key: string;
  totalBytes: number;
  nextSeq: number;
}

function hashLookup(hashBytes: DerivedArtifactContentHasher, contentHash: string, bytes: Uint8Array): boolean {
  try {
    return hashBytes(bytes) === contentHash;
  } catch {
    // A hasher that rejects the byte shape (e.g. an over-cap artifact) is a failed check, not a cache error.
    return false;
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("derived artifact cache request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("derived artifact cache transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("derived artifact cache transaction aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DERIVED_ARTIFACT_CACHE_SCHEMA);
    request.onupgradeneeded = () => {
      const database = request.result;
      // Schema versioning: any version change rebuilds both stores from scratch. Entries are
      // only a performance hint, and a stale layout cannot be trusted to keep its invariants.
      if (database.objectStoreNames.contains(ARTIFACT_STORE)) database.deleteObjectStore(ARTIFACT_STORE);
      if (database.objectStoreNames.contains(META_STORE)) database.deleteObjectStore(META_STORE);
      const store = database.createObjectStore(ARTIFACT_STORE, { keyPath: "contentHash" });
      store.createIndex(SEQ_INDEX, SEQ_INDEX, { unique: true });
      database.createObjectStore(META_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("derived artifact cache open failed"));
    request.onblocked = () => reject(new Error("derived artifact cache open was blocked"));
  });
}

/**
 * IndexedDB-backed cache for browser realms (the derived worker and the main realm share the
 * origin's database). Returns null where IndexedDB is absent (headless gates, the sim host) —
 * callers must treat null as "no cache". Deterministic bounds: a persisted monotonic `nextSeq`
 * (never a wall clock) orders eviction strictly oldest-first, and `totalBytes` is maintained
 * transactionally with each mutation so the 512 MiB cap trims the same entries on every host.
 * The database opens lazily on first use and each operation is its own transaction; any
 * failure resolves to a cache miss/no-op by contract above.
 */
export function createIndexedDbDerivedArtifactCache(hashBytes: DerivedArtifactContentHasher): DerivedArtifactCache | null {
  if (typeof hashBytes !== "function") throw new TypeError("derived artifact cache requires a hash function");
  if (typeof indexedDB === "undefined") return null;
  let database: Promise<IDBDatabase> | null = null;
  const ready = (): Promise<IDBDatabase> => {
    database ??= openDatabase();
    return database;
  };
  return Object.freeze({
    async get(contentHash: string) {
      try {
        const db = await ready();
        const transaction = db.transaction([ARTIFACT_STORE, META_STORE], "readwrite");
        const store = transaction.objectStore(ARTIFACT_STORE);
        const record = await requestToPromise(store.get(contentHash)) as
          | Readonly<{ byteLength: number; bytes: Uint8Array | ArrayBuffer }>
          | undefined;
        if (record === undefined) {
          await transactionDone(transaction);
          return undefined;
        }
        const bytes = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
        if (bytes.byteLength !== record.byteLength || !hashLookup(hashBytes, contentHash, bytes)) {
          // Corruption guard: evict the poisoned entry and report a miss so the caller
          // refetches from the authoritative network path.
          const meta = (await requestToPromise(transaction.objectStore(META_STORE).get(META_KEY)) as MetaRecord | undefined)
            ?? { key: META_KEY, totalBytes: 0, nextSeq: 0 };
          meta.totalBytes = Math.max(0, meta.totalBytes - record.byteLength);
          store.delete(contentHash);
          transaction.objectStore(META_STORE).put(meta);
          await transactionDone(transaction);
          return undefined;
        }
        await transactionDone(transaction);
        return bytes;
      } catch {
        return undefined;
      }
    },
    async put(contentHash: string, bytes: Uint8Array) {
      try {
        const db = await ready();
        const transaction = db.transaction([ARTIFACT_STORE, META_STORE], "readwrite");
        const store = transaction.objectStore(ARTIFACT_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        const prior = await requestToPromise(store.get(contentHash)) as Readonly<{ byteLength: number }> | undefined;
        const meta = (await requestToPromise(metaStore.get(META_KEY)) as MetaRecord | undefined)
          ?? { key: META_KEY, totalBytes: 0, nextSeq: 0 };
        if (prior !== undefined) meta.totalBytes = Math.max(0, meta.totalBytes - prior.byteLength);
        meta.totalBytes += bytes.byteLength;
        meta.nextSeq += 1;
        store.put({ contentHash, byteLength: bytes.byteLength, seq: meta.nextSeq, bytes });
        metaStore.put(meta);
        // Deterministic trim: strictly insertion order (lowest seq first) until the cap holds.
        while (meta.totalBytes > DERIVED_ARTIFACT_CACHE_MAX_BYTES) {
          const cursor = await requestToPromise(store.index(SEQ_INDEX).openCursor());
          if (cursor === null) break;
          const oldest = cursor.value as Readonly<{ contentHash: string; byteLength: number }>;
          meta.totalBytes = Math.max(0, meta.totalBytes - oldest.byteLength);
          store.delete(oldest.contentHash);
          metaStore.put(meta);
        }
        await transactionDone(transaction);
      } catch {
        // A failed store is a lost hint, never a failed activation.
      }
    },
  });
}

/**
 * In-memory cache with the exact trust contract of the IndexedDB one (re-hash on read,
 * insertion-order trim at the same cap, no write-time verification) for headless gates and
 * any realm without IndexedDB that still wants cross-activation reuse within one process.
 */
export function createMemoryDerivedArtifactCache(hashBytes: DerivedArtifactContentHasher): DerivedArtifactCache {
  if (typeof hashBytes !== "function") throw new TypeError("derived artifact cache requires a hash function");
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;
  return Object.freeze({
    async get(contentHash: string) {
      const bytes = entries.get(contentHash);
      if (bytes === undefined) return undefined;
      if (!hashLookup(hashBytes, contentHash, bytes)) {
        entries.delete(contentHash);
        totalBytes = Math.max(0, totalBytes - bytes.byteLength);
        return undefined;
      }
      return bytes;
    },
    async put(contentHash: string, bytes: Uint8Array) {
      const prior = entries.get(contentHash);
      if (prior !== undefined) totalBytes = Math.max(0, totalBytes - prior.byteLength);
      // Delete-then-set keeps Map iteration order equal to latest-insertion order, so the
      // trim below evicts in exactly the IndexedDB seq order.
      entries.delete(contentHash);
      entries.set(contentHash, bytes);
      totalBytes += bytes.byteLength;
      while (totalBytes > DERIVED_ARTIFACT_CACHE_MAX_BYTES) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        totalBytes = Math.max(0, totalBytes - entries.get(oldest.value)!.byteLength);
        entries.delete(oldest.value);
      }
    },
  });
}
