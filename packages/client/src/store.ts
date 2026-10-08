import type { Account, Holding, Me, Visit } from "./api.js";
import type { OutboxEntry } from "./outbox.js";

/**
 * What the device has to be able to remember, as an interface with no storage in it.
 *
 * The browser implementation is IndexedDB (`apps/field`); the tests use a Map. The split
 * is the repo's own: a contracts layer that cannot touch a socket, and one impure sibling
 * that does nothing but persist. It also means the sync engine below is testable without
 * a DOM, which is the difference between an offline protocol that is verified and one
 * that is hoped for.
 *
 * `replaceOutbox` rather than per-entry writes, because every outbox transition is
 * computed as a whole array by `applySyncResults` — and a partial write of that array is
 * a queue that lost rows. One atomic swap, or nothing.
 */
export interface ClientStore {
  readOutbox(): Promise<readonly OutboxEntry[]>;
  replaceOutbox(entries: readonly OutboxEntry[]): Promise<void>;

  /** Reference data, cached so the app opens with something on a cold start offline. */
  readCache(): Promise<CachedReference | null>;
  writeCache(cache: CachedReference): Promise<void>;
}

export interface CachedReference {
  readonly me: Me;
  readonly accounts: readonly Account[];
  readonly visits: readonly Visit[];
  /**
   * What the rep is carrying, cached for the same reason the accounts are: a disbursement
   * at a clinic desk with no signal needs the lot, its expiry and its balance, and none of
   * those can be fetched there.
   *
   * Optional, because a cache written by an earlier build has none — and a store that
   * throws on an older record would lose a rep's whole queue on an upgrade.
   */
  readonly holdings?: readonly Holding[];
  /** Epoch ms of the fetch, so the UI can say how stale it is instead of implying fresh. */
  readonly fetchedAt: number;
}
