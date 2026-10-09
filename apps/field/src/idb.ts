import { normalizeStoredOutbox } from "@crm/client";
import type { CachedReference, ClientStore, OutboxEntry } from "@crm/client";

/**
 * The device's memory: IndexedDB, behind `ClientStore`.
 *
 * IndexedDB rather than localStorage for one reason that matters more than capacity: it
 * is transactional. The outbox is swapped as a whole array — `applySyncResults` computes
 * the next queue in one go, and a partial write of that is a queue that lost rows — so
 * the clear-and-put below runs inside one `readwrite` transaction and either lands or
 * does not.
 *
 * Opening can fail: a private window, a device whose storage is full, a browser with site
 * data blocked. That is not an error to swallow — a rep who thinks a visit is saved and
 * is not has lost it — so `openStore` rejects and the caller tells them, rather than the
 * app silently running with no persistence.
 */
const DB_NAME = "crm-field";
const DB_VERSION = 1;
const OUTBOX = "outbox";
const CACHE = "cache";
const CACHE_KEY = "reference";

export function openDatabase(indexedDbImpl: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDbImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE);
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void =>
      reject(new Error(`this device would not open its local database: ${request.error?.message ?? "unknown"}`));
    request.onblocked = (): void => reject(new Error("another tab is holding the local database open"));
  });
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = (): void => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function indexedDbStore(db: IDBDatabase): ClientStore {
  return {
    async readOutbox(): Promise<readonly OutboxEntry[]> {
      const tx = db.transaction(OUTBOX, "readonly");
      const all = await wrap(tx.objectStore(OUTBOX).getAll() as IDBRequest<OutboxEntry[]>);
      // Normalized on the way out, in the one place rows come back from storage. A queue
      // written before `dependsOn` became a list would otherwise look permanently undue,
      // and a signature stored before the path parameter was its own field would be posted
      // to `/disbursements/undefined/signature`.
      return normalizeStoredOutbox(all);
    },

    async replaceOutbox(entries: readonly OutboxEntry[]): Promise<void> {
      // ONE transaction for the clear and every put. Two transactions would leave a
      // window in which the queue is empty, and a tab killed inside that window loses
      // the lot.
      const tx = db.transaction(OUTBOX, "readwrite");
      const store = tx.objectStore(OUTBOX);
      store.clear();
      for (const entry of entries) store.put(entry);
      await done(tx);
    },

    async readCache(): Promise<CachedReference | null> {
      const tx = db.transaction(CACHE, "readonly");
      const value = await wrap(tx.objectStore(CACHE).get(CACHE_KEY) as IDBRequest<CachedReference | undefined>);
      return value ?? null;
    },

    async writeCache(cache: CachedReference): Promise<void> {
      const tx = db.transaction(CACHE, "readwrite");
      tx.objectStore(CACHE).put(cache, CACHE_KEY);
      await done(tx);
    },
  };
}
