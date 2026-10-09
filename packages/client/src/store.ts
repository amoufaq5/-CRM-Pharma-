import type {
  Account,
  Count,
  FailedErpWrite,
  Obligation,
  Holding,
  IncomingTransfer,
  Me,
  RecallableTransfer,
  TransferPeer,
  Visit,
  Warehouse,
} from "./api.js";
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
  /**
   * The two halves of an open transfer, and who one can be addressed to.
   *
   * Cached for the same reason as the holdings, with one difference worth stating: these
   * are the only cached lists a rep ACTS on rather than reads. Accepting from a stale list
   * is safe — the acceptance carries the transfer's id, and the server refuses an id that
   * has already been settled — but the screen has to say how old the list is, because
   * "accept" on a transfer somebody recalled an hour ago will be refused and the rep
   * deserves to know why.
   *
   * All optional: a cache written by an earlier build has none, and refusing it would cost
   * a rep their queue on an upgrade.
   */
  readonly incoming?: readonly IncomingTransfer[];
  readonly recallable?: readonly RecallableTransfer[];
  readonly peers?: readonly TransferPeer[];
  /**
   * The rep's counts, cached for one reason: an OPEN count refuses every count afterwards,
   * so a device that cannot see it would offer a button that always fails.
   */
  readonly counts?: readonly Count[];
  /**
   * What this rep must dispose of, and by when.
   *
   * Cached because the deadline is the point: a rep standing in front of expired stock
   * with no signal needs to know it is overdue, and that fact does not change while they
   * are offline — the only thing that changes is how overdue.
   */
  readonly obligations?: readonly Obligation[];
  /**
   * Writes the ERP will never hear about unless somebody retries them.
   *
   * Cached like the rest so the fact survives going offline — but it is the one cached
   * list whose ACTION needs a network, because retrying is a request to a queue that
   * lives on the server.
   */
  readonly failedErpWrites?: readonly FailedErpWrite[];
  /**
   * The depots a return can be addressed to.
   *
   * Cached because this is the one reference list whose absence CHANGES WHAT A REP CAN DO
   * rather than only what they can see: with no list on the device, a return has no
   * destination to offer and the only exit left for expired stock is a write-off — which
   * destroys material a depot could have taken back. A stale list is a far smaller problem
   * than no list, and the server re-checks the chosen depot when the return drains, so a
   * depot that closed meanwhile is refused with its own sentence rather than silently
   * accepted.
   */
  readonly warehouses?: readonly Warehouse[];
  /** Epoch ms of the fetch, so the UI can say how stale it is instead of implying fresh. */
  readonly fetchedAt: number;
}
