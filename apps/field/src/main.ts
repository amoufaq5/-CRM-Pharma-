import {
  AcceptBody,
  Account,
  AccountList,
  Count,
  CountBody,
  CountList,
  DisposalPolicy,
  FailedErpWriteList,
  MyRoles,
  ConfigChangeList,
  PolicyBody,
  PolicyChangeList,
  Obligation,
  ObligationList,
  ReturnBody,
  WriteOffBody,
  DisbursementBody,
  Holding,
  HoldingList,
  IncomingTransferList,
  Me,
  RecallBody,
  RecallableTransferList,
  TransferBody,
  TransferPeerList,
  VisitBody,
  WarehouseList,
  countLineKey,
  discardCount,
  enqueueAcceptance,
  enqueueCount,
  enqueueCountCancel,
  enqueueCountCommit,
  enqueueCountLine,
  enqueueDisbursement,
  enqueueReturn,
  enqueueWriteOff,
  enqueueRecall,
  enqueueSignature,
  enqueueTransfer,
  enqueueVisit,
  heldForOthers,
  mintUuidV7,
  partsOfCount,
  summariseOutbox,
  syncOnce,
  type CachedReference,
  type ClientStore,
  type IncomingTransfer,
  type OutboxEntry,
  type FailedErpWrite,
  type RecallableTransfer,
  type SyncReport,
  type WriteOffKind,
  type ConfigChange,
  type PolicyChange,
  type TransferPeer,
  type Warehouse,
} from "@crm/client";

import { capture, createSignaturePad, type SignaturePad } from "./signature.js";

import { beginLogin, completeLogin, isExpired, readCallback, sessionStorageAuth, type Session } from "./auth.js";
import { loadConfig, type FieldConfig } from "./config.js";
import { indexedDbStore, openDatabase } from "./idb.js";
import { clearSession, readSession, writeSession } from "./session-store.js";
import { ApiTransport } from "./transport.js";

declare const __DEV_TOKEN_LOGIN__: boolean;

/**
 * The app: log in, see my accounts, record a visit offline, watch it sync.
 *
 * Hand-rolled rather than framework-rendered, and the reason is the same one that drove
 * the rest of this repo to zero runtime dependencies: every library here would ship to a
 * phone on a rural 3G connection, and this screen is a list and a form. State lives in
 * one object, `render()` rebuilds from it, and the offline behaviour that actually
 * matters lives in `@crm/client` where it is tested without a browser.
 *
 * What the UI owes the rep, and the whole reason it is not just a form:
 *   - it never claims a visit is filed when it is queued;
 *   - it says how stale the account list is, rather than implying it is live;
 *   - a refused visit stays on screen with the server's own sentence attached.
 */
interface State {
  phase: "booting" | "login" | "ready" | "fatal";
  config: FieldConfig | null;
  session: Session | null;
  me: Me | null;
  accounts: readonly Account[];
  holdings: readonly Holding[];
  /** The two open halves of a transfer, and who one can be addressed to. */
  incoming: readonly IncomingTransfer[];
  recallable: readonly RecallableTransfer[];
  peers: readonly TransferPeer[];
  /** Counts the server knows about, which is how an OPEN one becomes visible here. */
  counts: readonly Count[];
  /** What this rep must dispose of, soonest deadline first. */
  obligations: readonly Obligation[];
  /** What this rep recorded that the ERP will never hear about unless it is retried. */
  failedErpWrites: readonly FailedErpWrite[];
  /**
   * The depots a return can be addressed to.
   *
   * The one reference list whose absence changes what a rep can DO rather than only what
   * they can see: with no list, a return has no destination to offer and expired stock's
   * only exit is a write-off — material destroyed that a depot could have put back.
   */
  warehouses: readonly Warehouse[];
  /**
   * The SOP parameters the rep is measured against, and who set them.
   *
   * Null until a refresh has answered, which is not the same as "the default": a device
   * that showed thirty days before it had asked would be stating a tenant-wide rule it had
   * never been told.
   */
  policy: DisposalPolicy | null;
  policyChanges: readonly PolicyChange[];
  /** The tenant's configuration history. Only ever non-empty for an `administrator`. */
  configChanges: readonly ConfigChange[];
  /**
   * The administrative roles this rep holds, from `GET /v1/me/roles`.
   *
   * Empty is the right default for a device that has not asked: offering a form every write
   * would refuse is worse than making a compliance officer press Refresh once.
   */
  roles: readonly string[];
  /** True while the policy form is open. Only ever reachable with the `compliance` role. */
  editingPolicy: boolean;
  cachedAt: number | null;
  outbox: readonly OutboxEntry[];
  online: boolean;
  /** The account a visit is being recorded against, if the form is open. */
  recording: Account | null;
  /** The lot being disbursed, if that form is open. */
  disbursing: Holding | null;
  /** The lot being transferred to a colleague, if that form is open. */
  transferring: Holding | null;
  /** True while the count form is open. A count is the whole bag, not one lot. */
  counting: boolean;
  /** The lot being taken out of custody, and why this screen was opened. */
  writingOff: { holding: Holding; because: "expired" | "chosen" } | null;
  /** The lot going back to a warehouse, if that form is open. */
  returning: Holding | null;
  message: { kind: "good" | "warn" | "error"; text: string } | null;
  blocked: string | null;
  syncing: boolean;
}

const state: State = {
  phase: "booting",
  config: null,
  session: null,
  me: null,
  accounts: [],
  holdings: [],
  incoming: [],
  recallable: [],
  peers: [],
  counts: [],
  obligations: [],
  failedErpWrites: [],
  warehouses: [],
  policy: null,
  policyChanges: [],
  configChanges: [],
  roles: [],
  editingPolicy: false,
  cachedAt: null,
  outbox: [],
  online: navigator.onLine,
  recording: null,
  disbursing: null,
  transferring: null,
  counting: false,
  writingOff: null,
  returning: null,
  message: null,
  blocked: null,
  syncing: false,
};

let store: ClientStore | null = null;
let transport: ApiTransport | null = null;
/** The live pad, so a re-render can detach the old canvas's listeners. */
let pad: SignaturePad | null = null;
/**
 * The strokes drawn so far, carried across a re-render.
 *
 * `render()` replaces the DOM, which replaces the canvas, which discards what was drawn
 * on it — and the events that trigger a render include `online`, which is exactly what
 * fires when a rep in a clinic regains signal mid-signature. Snapshotting here and
 * restoring in `wireReady` is what stops their signature disappearing without a word.
 */
let signatureInProgress: ImageData | null = null;
/**
 * What the rep has typed into the open form, carried across a re-render.
 *
 * THE SAME DEFECT THE SIGNATURE HAD, in the part of the form nobody thought to check.
 * `render()` replaces the DOM from every state change — including the one that reports a
 * refusal — so a rep who typed a reason, a quantity or eleven counted lots and then hit
 * "you are carrying 6, so 99 cannot be written off" lost all of it along with the message
 * telling them to fix one field. For a write-off the reason is the only record of why
 * regulated material no longer exists, and what a retyped one says is shorter every time.
 *
 * Keyed by the form's id so a draft cannot leak between screens, and cleared whenever a
 * form is opened or closed — a fresh form starts blank, which is a rule two earlier
 * increments wrote down and this would otherwise break.
 */
let formDraft: { readonly formId: string; readonly values: Readonly<Record<string, string>> } | null = null;

/** Read the open form, if there is one. Synchronous, immediately before the DOM goes. */
function captureFormDraft(): void {
  const form = document.querySelector("form[id]");
  if (!(form instanceof HTMLFormElement)) return;
  const values: Record<string, string> = {};
  for (const el of form.querySelectorAll("input[name], select[name], textarea[name]")) {
    if (el instanceof HTMLInputElement) {
      values[el.name] = el.type === "checkbox" ? (el.checked ? "1" : "") : el.value;
    } else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      values[el.name] = el.value;
    }
  }
  formDraft = { formId: form.id, values };
}

/** Put it back, into the same form. A different form on screen means the draft is not its. */
function restoreFormDraft(): void {
  const draft = formDraft;
  if (draft === null) return;
  const form = document.getElementById(draft.formId);
  if (!(form instanceof HTMLFormElement)) return;
  for (const [name, value] of Object.entries(draft.values)) {
    const el = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") el.checked = value === "1";
      else el.value = value;
    } else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      el.value = value;
    }
  }
}

const app = (): HTMLElement => {
  const el = document.getElementById("app");
  if (el === null) throw new Error("the page has no #app to render into");
  return el;
};

function text(value: string | null | undefined, fallback = "—"): string {
  return value === null || value === undefined || value === "" ? fallback : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * What a queued row IS, in a rep's words.
 *
 * The type system asked for this: under the entry union, rendering `body.erpAccountId`
 * stopped compiling, and the reason it stopped is the reason the UI was wrong — "ACC-1"
 * tells a rep nothing about which of two refused things it was. A disbursement names the
 * recipient; a signature names the disbursement it belongs to.
 */
function describeEntry(entry: OutboxEntry): string {
  switch (entry.kind) {
    case "visit":
      return `Visit — ${entry.body.erpAccountId}`;
    case "disbursement":
      return `Samples to ${entry.body.recipientName} — ${entry.body.quantity} unit(s)`;
    case "signature":
      return `Signature for disbursement ${entry.dependsOn.slice(0, 8)}`;
    case "transfer":
      return `${entry.body.quantity} unit(s) to ${nameOfPeer(entry.body.toRepProfileId)}`;
    case "acceptance":
      return `Accepting transfer ${entry.transferOf.slice(0, 8)}`;
    case "recall":
      return `Taking back transfer ${entry.transferOf.slice(0, 8)}`;
    case "count":
      return `Stock count of ${new Date(entry.body.countedAt).toLocaleDateString()}`;
    case "count_line":
      return `Counted ${entry.body.countedQuantity} of ${nameOfLot(entry.body.lotId)}`;
    case "count_commit":
      return `Committing the count — one adjustment per difference`;
    case "count_cancel":
      return `Abandoning the count of ${entry.countOf.slice(0, 8)}`;
    case "write_off":
      return `${entry.body.kind === "destruction" ? "Destroyed" : "Written off"} ${entry.body.quantity} of ${nameOfLot(entry.body.lotId)}`;
    case "return_to_warehouse":
      return `Returned ${entry.body.quantity} of ${nameOfLot(entry.body.lotId)} to ${nameOfWarehouse(entry.body.erpWarehouseId)}`;
  }
}

/** A lot id as a lot number, where the device still has the holding that names it. */
function nameOfLot(lotId: string): string {
  return state.holdings.find((h) => h.lot_id === lotId)?.lot_number ?? lotId.slice(0, 8);
}

/**
 * A warehouse id as the code a rep would recognise, where the device knows one.
 *
 * Falls back to the id for the same reason `nameOfPeer` does: a queued return addressed to
 * a depot that has since left the list still has to be describable, and the id is what the
 * ERP will be told either way.
 */
function nameOfWarehouse(erpWarehouseId: string): string {
  return state.warehouses.find((w) => w.erp_warehouse_id === erpWarehouseId)?.code ?? erpWarehouseId;
}

/**
 * A rep id as a name, where the device knows one.
 *
 * Falls back to a short id rather than to nothing: a queued transfer whose recipient has
 * since left the peer list still has to be describable, and "to 3f2b91c4" is a worse
 * sentence than a name but a much better one than "to undefined".
 */
function nameOfPeer(repProfileId: string): string {
  const peer = state.peers.find((p) => p.rep_profile_id === repProfileId);
  if (peer !== undefined) return peer.display_name;
  const incoming = state.incoming.find((t) => t.sent_by === repProfileId);
  if (incoming !== undefined) return incoming.sent_by_name;
  const sent = state.recallable.find((t) => t.sent_to === repProfileId);
  return sent?.sent_to_name ?? repProfileId.slice(0, 8);
}

/**
 * Who is signed in, for a row that has to name its author.
 *
 * Null is a refusal rather than a default: every write route attributes the record to the
 * caller, so a row queued without an author either gets sent under whoever signs in next —
 * misattributing it — or is held forever. Both are worse than declining to record it.
 */
function authorId(): string | null {
  return state.me?.repProfileId ?? null;
}

function ago(from: number | null, now: number): string {
  if (from === null) return "never";
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

// ---- rendering ------------------------------------------------------------

function render(): void {
  const now = Date.now();
  // BEFORE the DOM goes. Synchronous, because anything async would resolve after the
  // canvas it was reading had been replaced.
  if (pad !== null) signatureInProgress = pad.snapshot() ?? signatureInProgress;
  captureFormDraft();
  const root = app();
  root.setAttribute("aria-busy", state.phase === "booting" ? "true" : "false");

  if (state.phase === "booting") {
    root.innerHTML = `<p class="booting">Starting…</p>`;
    return;
  }
  if (state.phase === "fatal") {
    root.innerHTML = `<section><h2>This device cannot run the app</h2><p class="error">${escapeHtml(state.message?.text ?? "unknown")}</p>
      <p class="note">Nothing has been lost: no visit is recorded until this is working.</p></section>`;
    return;
  }

  const summary = summariseOutbox(state.outbox, now);
  const parts: string[] = [];

  parts.push(`<header class="bar">
    <h1>Field</h1>
    ${state.me !== null ? `<span class="who">${escapeHtml(state.me.displayName)}</span>` : ""}
    <span class="pill ${state.online ? "online" : "offline"}">${state.online ? "online" : "offline"}</span>
    ${state.blocked !== null ? `<span class="pill blocked">stopped</span>` : ""}
  </header>`);

  if (state.message !== null) {
    parts.push(`<p class="${state.message.kind === "good" ? "good" : state.message.kind === "warn" ? "warn" : "error"}">${escapeHtml(state.message.text)}</p>`);
  }

  if (state.blocked !== null) {
    // The one condition that is not a transient failure: the ERP deleted this tenant.
    // Said plainly, with the queue frozen, because retrying is what the API asked this
    // client not to do.
    parts.push(`<section><h2>Syncing has stopped</h2>
      <p class="error">${escapeHtml(state.blocked)}</p>
      <p class="note">${summary.blocked} record(s) are held on this device and will not be sent. Nothing is deleted. Speak to your administrator.</p></section>`);
  }

  if (state.phase === "login") {
    parts.push(renderLogin());
    root.innerHTML = parts.join("");
    wireLogin();
    return;
  }

  parts.push(renderOutbox(summary, now));
  if (state.recording !== null) {
    parts.push(renderVisitForm(state.recording));
  } else if (state.disbursing !== null) {
    parts.push(renderDisburseForm(state.disbursing));
  } else if (state.transferring !== null) {
    parts.push(renderTransferForm(state.transferring));
  } else if (state.counting) {
    parts.push(renderCountForm(now));
  } else if (state.writingOff !== null) {
    parts.push(renderWriteOffForm(state.writingOff));
  } else if (state.returning !== null) {
    parts.push(renderReturnForm(state.returning, now));
  } else if (state.editingPolicy) {
    parts.push(renderPolicyForm());
  } else {
    parts.push(renderAccounts(now));
    // Before anything else a rep might do: a write the ERP never heard about is the one
    // thing on this screen that somebody outside the CRM is waiting for.
    parts.push(renderFailedErpWrites(now));
    // Before the stock itself: a deadline is the thing on this screen with a clock running.
    parts.push(renderObligations(now));
    parts.push(renderHoldings(now));
    parts.push(renderTransfers(now));
    parts.push(renderCounts(now));
    // LAST, deliberately. It is the rule the rest of the screen is measured against rather
    // than anything a rep does today, and a tenant-wide parameter above a rep's own work
    // would be the wrong emphasis on a phone.
    parts.push(renderPolicy(now));
    // After the policy, because it is the same kind of thing one layer out: the policy is
    // one tenant-wide rule with a screen of its own, this is every OTHER tenant-wide
    // setting's history. Empty for everybody but an administrator, and empty sections
    // render as nothing.
    parts.push(renderConfigHistory());
  }

  root.innerHTML = parts.join("");
  wireReady();
  // After the DOM is back and before the rep can type into it.
  restoreFormDraft();
}

function renderLogin(): string {
  const issuer = state.config?.oidc.issuer ?? "";
  const canOidc = issuer !== "";
  return `<section>
    <h2>Sign in</h2>
    ${canOidc
      ? `<p class="note">You will be sent to your organisation's sign-in page.</p>
         <div class="actions"><button id="login">Sign in</button></div>`
      : `<p class="warn">No identity provider is configured for this deployment, so there is no sign-in to offer.</p>
         <p class="note">Set <code>oidc.issuer</code> in <code>config.json</code>. The API verifies tokens against that issuer's JWKS and never sees a password.</p>`}
    ${__DEV_TOKEN_LOGIN__
      ? `<div class="dev" style="margin-top:1rem">
           <strong>Development build.</strong> A token can be pasted here instead of signing in.
           This path is compiled out of a production bundle entirely.
           <label style="margin-top:.5rem">Access token
             <input id="dev-token" type="text" autocomplete="off" spellcheck="false" placeholder="eyJ…" />
           </label>
           <label>Tenant id (sent as x-tenant-id when the token carries no tenant claim)
             <input id="dev-tenant" type="text" autocomplete="off" spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000" />
           </label>
           <div class="actions"><button id="dev-login" class="secondary">Use this token</button></div>
         </div>`
      : ""}
  </section>`;
}

function renderOutbox(summary: ReturnType<typeof summariseOutbox>, now: number): string {
  const rejected = state.outbox.filter((e) => e.state === "rejected");
  const lines: string[] = [];

  // Rows this device is holding for somebody else, said out loud. Without this line a rep
  // sees a count that never moves and no reason for it — and the reason matters, because
  // the remedy is for the other rep to sign in, not for this one to keep pressing Sync.
  const held = state.me === null ? 0 : heldForOthers(state.outbox, state.me.repProfileId);
  if (state.me === null && state.outbox.length > 0) {
    // Signed in, offline, and `/v1/me` has never answered for this session — so the
    // device genuinely does not know who is here. The queue is not sent and the count is
    // not silently stuck: this says why, and what fixes it.
    lines.push(`<section>
      <h2>Waiting to know who is signed in (${state.outbox.length})</h2>
      <p class="note">This device is holding ${state.outbox.length} record(s) and cannot
        send them yet: every record is filed against whoever is signed in, and this
        sign-in has not reached the server once. Connect, and they will be sorted by who
        recorded them.</p>
    </section>`);
  }
  if (held > 0) {
    lines.push(`<section>
      <h2>Held for another sign-in (${held})</h2>
      <p class="note">${held} record(s) on this device were recorded under a different
        sign-in. They are not sent — every record is filed against whoever is signed in, so
        sending them would put somebody else's name on them — and they are not deleted.
        That rep can sign in here and send them.</p>
    </section>`);
  }

  lines.push(`<section>
    <h2>On this device</h2>
    <ul class="list">
      <li><span class="grow"><span class="name">${summary.pending} record(s) waiting to send</span>
        <span class="meta">${summary.pending === 0 ? "everything recorded here has been accepted" : `oldest ${ago(summary.oldestQueuedAt, now)}${summary.dueNow < summary.pending ? `, ${summary.pending - summary.dueNow} backing off` : ""}`}</span></span>
        <button id="sync" class="secondary" ${state.syncing || state.blocked !== null ? "disabled" : ""}>${state.syncing ? "Syncing…" : "Sync now"}</button></li>
    </ul>
  </section>`);

  if (rejected.length > 0) {
    lines.push(`<section>
      <h2>Refused by the server (${rejected.length})</h2>
      <p class="note">These are kept, not deleted. The server's own words:</p>
      <ul class="list">
        ${rejected
          .map(
            (e) => `<li><span class="grow"><span class="name">${escapeHtml(describeEntry(e))}</span>
              <span class="meta error">${escapeHtml(e.lastReason ?? "refused")}</span></span>
              <button class="secondary" data-discard="${escapeHtml(e.id)}">Discard</button></li>`,
          )
          .join("")}
      </ul>
    </section>`);
  }
  return lines.join("");
}

function renderAccounts(now: number): string {
  if (state.accounts.length === 0) {
    return `<section><h2>My accounts</h2>
      <p class="note">No accounts are cached on this device yet${state.online ? "" : ", and there is no network to fetch them"}.</p>
      <div class="actions"><button id="refresh" class="secondary" ${state.online ? "" : "disabled"}>Refresh</button></div></section>`;
  }
  return `<section>
    <h2>My accounts (${state.accounts.length})</h2>
    <p class="note">Cached ${ago(state.cachedAt, now)}${state.online ? "" : " — offline, so this is what the device had"}.</p>
    <ul class="list">
      ${state.accounts
        .map(
          (a) => `<li><span class="grow">
            <span class="name">${escapeHtml(text(a.name, a.erp_account_id))}</span>
            <span class="meta">${escapeHtml(a.erp_account_id)}${a.country !== null ? ` · ${escapeHtml(a.country)}` : ""}${a.name === null ? " · not yet in the snapshot" : ""}</span>
          </span>
          <button data-visit="${escapeHtml(a.erp_account_id)}">Record visit</button></li>`,
        )
        .join("")}
    </ul>
    <div class="actions"><button id="refresh" class="secondary" ${state.online ? "" : "disabled"}>Refresh</button></div>
  </section>`;
}

function renderHoldings(now: number): string {
  if (state.holdings.length === 0) {
    return `<section><h2>My samples</h2>
      <p class="note">No stock is cached on this device${state.online ? "" : ", and there is no network to fetch it"}.
      A rep holds material only after confirming receipt from a warehouse.</p></section>`;
  }
  const today = new Date().toISOString().slice(0, 10);
  return `<section>
    <h2>My samples (${state.holdings.length} lot(s))</h2>
    <ul class="list">
      ${state.holdings
        .map((h) => {
          // Expiry is the one fact a rep must not have to work out: disbursing an expired
          // lot is refused by the database, and finding that out through a queued refusal
          // hours later is the worst way to learn it.
          const expired = h.expiry_date !== null && h.expiry_date <= today;
          return `<li><span class="grow">
            <span class="name">${escapeHtml(h.lot_number)} · ${escapeHtml(h.erp_item_id)}</span>
            <span class="meta${expired ? " error" : ""}">${escapeHtml(h.quantity_on_hand)} on hand${h.expiry_date !== null ? ` · expires ${escapeHtml(h.expiry_date)}${expired ? " — EXPIRED" : ""}` : ""}${Number(h.quantity_in_transit) > 0 ? ` · ${escapeHtml(h.quantity_in_transit)} in transit` : ""}</span>
          </span>
          <button data-disburse="${escapeHtml(h.lot_id)}" ${expired || Number(h.quantity_on_hand) <= 0 ? "disabled" : ""}>Disburse</button>
          <button class="secondary" data-transfer="${escapeHtml(h.lot_id)}" ${Number(h.quantity_on_hand) <= 0 ? "disabled" : ""}>Transfer</button>
          <button class="secondary" data-write-off="${escapeHtml(h.lot_id)}" ${Number(h.quantity_on_hand) <= 0 ? "disabled" : ""}>Write off</button>
          <button class="secondary" data-return="${escapeHtml(h.lot_id)}" ${Number(h.quantity_on_hand) <= 0 ? "disabled" : ""}>Send back</button></li>`;
        })
        .join("")}
    </ul>
    <div class="actions">
      <button id="start-count" class="secondary" ${countBlocked() !== null ? "disabled" : ""}>Count my samples</button>
    </div>
    ${countBlocked() !== null ? `<p class="note">${escapeHtml(countBlocked() ?? "")}</p>` : ""}
  </section>`;
}

/**
 * Why a count cannot be started, or null when one can.
 *
 * Said on the screen rather than discovered as a refusal. `uq_sample_count_one_open`
 * permits one open count per rep, so both of these are states the rep can see and settle —
 * and neither is guessable from a button that has simply stopped working.
 */
function countBlocked(): string | null {
  if (state.outbox.some((e) => e.kind === "count")) {
    return "A count recorded on this device is still waiting to send. Sync it, or discard it below, before counting again.";
  }
  const mine = state.me?.repProfileId ?? null;
  if (state.counts.some((c) => c.status === "open" && (mine === null || c.rep_profile_id === mine))) {
    return "A count of your bag is still open. Settle it below before starting another.";
  }
  return null;
}

function renderDisburseForm(holding: Holding): string {
  return `<section>
    <h2>Disburse — ${escapeHtml(holding.lot_number)}</h2>
    <form id="disburse-form">
      <div class="row">
        <label>To account
          <select name="erpAccountId">
            ${state.accounts
              .map((a) => `<option value="${escapeHtml(a.erp_account_id)}">${escapeHtml(text(a.name, a.erp_account_id))}</option>`)
              .join("")}
          </select>
        </label>
        <label>Quantity (of ${escapeHtml(holding.quantity_on_hand)})
          <input name="quantity" type="text" inputmode="decimal" value="1" autocomplete="off" />
        </label>
      </div>
      <label>Received by
        <input name="recipientName" type="text" maxlength="200" autocomplete="off" placeholder="Name of the person signing" />
      </label>
      <label>Signature
        <canvas id="signature-pad" width="600" height="180"
                style="touch-action:none; background:#fff; border-radius:.4rem; width:100%; height:180px"></canvas>
      </label>
      <div class="actions">
        <button id="clear-signature" type="button" class="secondary">Clear signature</button>
      </div>
      <div class="actions">
        <button id="save-disbursement" type="submit">Record disbursement</button>
        <button id="cancel-disbursement" type="button" class="secondary">Cancel</button>
      </div>
      <p class="note">The ledger commits to a hash of this signature; the image follows once
        the disbursement itself has been accepted. Both are saved on this device first.</p>
    </form>
  </section>`;
}

/**
 * Hand material to a colleague.
 *
 * An EXPIRED lot can still be transferred, unlike disbursed. That asymmetry is the
 * database's, and it is right: a rep must not give expired material to a doctor, but they
 * may well have to hand it to the colleague who is taking it back to a warehouse for
 * destruction. Blocking the transfer would strand it in a bag with no legal way out.
 */
function renderTransferForm(holding: Holding): string {
  const expired = holding.expiry_date !== null && holding.expiry_date <= new Date().toISOString().slice(0, 10);
  return `<section>
    <h2>Transfer — ${escapeHtml(holding.lot_number)}</h2>
    ${state.peers.length === 0
      ? `<p class="warn">This device has no colleague list cached, so there is nobody to
           address a transfer to. Connect once and refresh.</p>
         <div class="actions"><button id="cancel-transfer" type="button" class="secondary">Back</button></div>`
      : `<form id="transfer-form">
          <div class="row">
            <label>To colleague
              <select name="toRepProfileId">
                ${state.peers
                  .map(
                    (p) => `<option value="${escapeHtml(p.rep_profile_id)}">${escapeHtml(p.display_name)} · ${escapeHtml(p.employee_number)}</option>`,
                  )
                  .join("")}
              </select>
            </label>
            <label>Quantity (of ${escapeHtml(holding.quantity_on_hand)})
              <input name="quantity" type="text" inputmode="decimal" value="1" autocomplete="off" />
            </label>
          </div>
          ${expired ? `<p class="warn">This lot has expired. It can still be handed over — for return or destruction — and the ledger records who had it.</p>` : ""}
          <div class="actions">
            <button id="save-transfer" type="submit">Send to colleague</button>
            <button id="cancel-transfer" type="button" class="secondary">Cancel</button>
          </div>
          <p class="note">The quantity leaves your balance and sits in transit until they
            accept it. Until then you can take it back.</p>
        </form>`}
  </section>`;
}

/**
 * The two open halves of a transfer, each on the side that can act on it.
 *
 * Deliberately two lists from two routes rather than one list with a direction: only the
 * receiver may accept and only the sender may recall, and the server scopes each list in
 * SQL. A single list would put both buttons in front of both reps and let the database
 * decide, which is a 403 a rep cannot do anything about.
 */
function renderTransfers(now: number): string {
  const sections: string[] = [];
  const queuedAcceptances = new Set(
    state.outbox.filter((e) => e.kind === "acceptance").map((e) => e.transferOf),
  );
  const queuedRecalls = new Set(state.outbox.filter((e) => e.kind === "recall").map((e) => e.transferOf));
  const unsentTransfers = state.outbox.filter((e) => e.kind === "transfer");

  if (state.incoming.length > 0) {
    sections.push(`<section>
      <h2>Sent to me (${state.incoming.length})</h2>
      <p class="note">Cached ${ago(state.cachedAt, now)}. Accepting adds it to your own balance.</p>
      <ul class="list">
        ${state.incoming
          .map((t) => {
            const queued = queuedAcceptances.has(t.transaction_id);
            return `<li><span class="grow">
              <span class="name">${escapeHtml(t.quantity)} × ${escapeHtml(t.lot_number)} from ${escapeHtml(t.sent_by_name)}</span>
              <span class="meta">${escapeHtml(t.erp_item_id)}${t.expiry_date !== null ? ` · expires ${escapeHtml(t.expiry_date)}` : ""} · ${t.days_in_transit} day(s) in transit${queued ? " · acceptance queued on this device" : ""}</span>
            </span>
            <button data-accept="${escapeHtml(t.transaction_id)}" ${queued ? "disabled" : ""}>Accept</button></li>`;
          })
          .join("")}
      </ul>
    </section>`);
  }

  if (state.recallable.length > 0 || unsentTransfers.length > 0) {
    sections.push(`<section>
      <h2>Sent by me, not yet accepted (${state.recallable.length + unsentTransfers.length})</h2>
      <ul class="list">
        ${unsentTransfers
          .map(
            (e) => `<li><span class="grow">
              <span class="name">${escapeHtml(describeEntry(e))}</span>
              <span class="meta">not sent yet — this device still has it</span>
            </span>
            <button class="secondary" data-unsend="${escapeHtml(e.id)}">Cancel</button></li>`,
          )
          .join("")}
        ${state.recallable
          .map((t) => {
            const queued = queuedRecalls.has(t.transaction_id);
            return `<li><span class="grow">
              <span class="name">${escapeHtml(t.quantity)} × ${escapeHtml(t.lot_number)} to ${escapeHtml(t.sent_to_name)}</span>
              <span class="meta">${t.days_in_transit} day(s) in transit${queued ? " · recall queued on this device" : ""}</span>
            </span>
            <button class="secondary" data-recall="${escapeHtml(t.transaction_id)}" ${queued ? "disabled" : ""}>Recall</button></li>`;
          })
          .join("")}
      </ul>
      <p class="note">A recall is a new ledger movement, never an edit: the material went
        out and came back, and both halves stay in the log.</p>
    </section>`);
  }

  return sections.join("");
}

/**
 * Count the whole bag.
 *
 * ONE SCREEN FOR THE WHOLE DOCUMENT, not a lot at a time, because that is how a count
 * happens: a rep empties the bag, counts what is in it, and writes the numbers down. The
 * server's routes are an interactive document; the device assembles it offline and drains
 * it in order when a signal returns.
 *
 * EVERY FIELD STARTS EMPTY, and that is the most important decision on this screen. The
 * expected figure is SHOWN beside each lot and never pre-filled: a form that arrives
 * holding the answer is a form a tired rep taps through, and what that produces is a
 * document saying somebody counted when nobody did. A blank field means "not counted", and
 * no line is sent for it.
 */
function renderCountForm(now: number): string {
  if (state.holdings.length === 0) {
    return `<section><h2>Count my samples</h2>
      <p class="note">There is no stock on this device to count.</p>
      <div class="actions"><button id="cancel-count" type="button" class="secondary">Back</button></div></section>`;
  }
  const today = new Date().toISOString().slice(0, 10);
  return `<section>
    <h2>Count my samples</h2>
    <p class="note">Counting ${state.holdings.length} lot(s). Leave a lot blank if you did not
      count it — only the ones you fill in are recorded. The balances shown are what this
      device last heard, ${ago(state.cachedAt, now)}.</p>
    <form id="count-form">
      <ul class="list">
        ${state.holdings
          .map((h) => {
            const expired = h.expiry_date !== null && h.expiry_date <= today;
            return `<li><span class="grow">
              <span class="name">${escapeHtml(h.lot_number)} · ${escapeHtml(h.erp_item_id)}</span>
              <span class="meta${expired ? " error" : ""}">device shows ${escapeHtml(h.quantity_on_hand)}${h.expiry_date !== null ? ` · expires ${escapeHtml(h.expiry_date)}${expired ? " — EXPIRED" : ""}` : ""}</span>
            </span>
            <input name="count:${escapeHtml(h.lot_id)}" type="text" inputmode="decimal" autocomplete="off"
                   placeholder="counted" style="max-width:7rem" /></li>`;
          })
          .join("")}
      </ul>
      <label>Note
        <input name="note" type="text" maxlength="2000" autocomplete="off" placeholder="Where and why, for whoever reviews it" />
      </label>
      <div class="actions">
        <button id="save-count" type="submit">Record this count</button>
        <button id="cancel-count" type="button" class="secondary">Cancel</button>
      </div>
      <p class="note">Each difference becomes an adjustment in the ledger, never an edit to a
        balance — so the count and what it corrected both stay in the log. The figures this
        device showed you are sent as well, beside the server's own, because for a count
        taken offline the two can honestly differ.</p>
    </form>
  </section>`;
}

/**
 * The count section: what is queued here, and what is open on the server.
 *
 * The open-count line is not decoration. `uq_sample_count_one_open` permits one open count
 * per rep, so a count left open — by a line that was refused, or by a manager counting this
 * rep's bag — refuses every count afterwards. Showing it WITH A WAY OUT is the difference
 * between a rep who can fix it and a rep whose button has stopped working for a reason they
 * cannot see.
 */
function renderCounts(now: number): string {
  const queued = state.outbox.filter((e) => e.kind === "count");
  const queuedLines = state.outbox.filter((e) => e.kind === "count_line");
  const mine = state.me?.repProfileId ?? null;
  const open = state.counts.filter((c) => c.status === "open" && (mine === null || c.rep_profile_id === mine));
  const openUnqueued = open.filter((c) => !queued.some((q) => q.id === c.id));
  if (queued.length === 0 && openUnqueued.length === 0) return "";

  const sections: string[] = [];
  if (queued.length > 0) {
    sections.push(`<section>
      <h2>A count on this device</h2>
      <ul class="list">
        ${queued
          .map(
            (e) => `<li><span class="grow">
              <span class="name">${escapeHtml(describeEntry(e))}</span>
              <span class="meta">${queuedLines.filter((l) => l.kind === "count_line" && l.countOf === e.id).length} lot(s) counted · waiting to send</span>
            </span>
            <button class="secondary" data-discard-count="${escapeHtml(e.id)}">Discard</button></li>`,
          )
          .join("")}
      </ul>
      <p class="note">Discarding it here writes nothing anywhere: the server has never seen it.</p>
    </section>`);
  }
  if (openUnqueued.length > 0) {
    sections.push(`<section>
      <h2>A count left open (${openUnqueued.length})</h2>
      <p class="warn">One count can be open at a time, so another cannot be started until
        this one is settled.</p>
      <ul class="list">
        ${openUnqueued
          .map(
            (c) => `<li><span class="grow">
              <span class="name">Count of ${escapeHtml(new Date(c.counted_at).toLocaleDateString())}</span>
              <span class="meta">${c.note === null ? "no note" : escapeHtml(c.note)} · still open on the server, cached ${ago(state.cachedAt, now)}</span>
            </span>
            <button class="secondary" data-cancel-count="${escapeHtml(c.id)}">Abandon it</button></li>`,
          )
          .join("")}
      </ul>
      <p class="note">Abandoning a count discards its findings and writes no adjustments.
        Counting again is how a balance gets corrected.</p>
    </section>`);
  }
  return sections.join("");
}

/**
 * Take material out of custody.
 *
 * TWO KINDS, AND THE DIFFERENCE IS THE RECORD. `destruction` says the material was
 * destroyed; `expiry_writeoff` says it stopped being counted. The route keeps them apart
 * deliberately and so does this form — a single "dispose" button would have made the ledger
 * unable to answer which happened, which is the question an inspector asks first.
 *
 * The quantity starts EMPTY for the same reason the count form's fields do: this is the one
 * screen in the app that records regulated material no longer existing, and a form that
 * arrives holding "all of it" is one a tired rep confirms without reading. The reason is
 * required by the server and refused here, because an empty one is a row the server must
 * reject hours later from inside a queue.
 */
function renderWriteOffForm(target: { holding: Holding; because: "expired" | "chosen" }): string {
  const { holding, because } = target;
  const obligation = state.obligations.find((o) => o.lot_id === holding.lot_id);
  return `<section>
    <h2>Out of custody — ${escapeHtml(holding.lot_number)}</h2>
    ${obligation !== undefined
      ? `<p class="${obligation.status === "overdue" ? "error" : "warn"}">This lot expired
           ${escapeHtml(obligation.expired_on)} and must be disposed of by
           ${escapeHtml(obligation.due_by)}${obligation.days_overdue > 0 ? ` — ${obligation.days_overdue} day(s) OVERDUE` : ""}.</p>`
      : ""}
    <form id="write-off-form">
      <div class="row">
        <label>What happened
          <select name="kind">
            <option value="destruction" ${because === "chosen" ? "selected" : ""}>Destroyed</option>
            <option value="expiry_writeoff" ${because === "expired" ? "selected" : ""}>Expired — written off</option>
          </select>
        </label>
        <label>Quantity (of ${escapeHtml(holding.quantity_on_hand)})
          <input name="quantity" type="text" inputmode="decimal" autocomplete="off" placeholder="how much" />
        </label>
      </div>
      <label>Reason — required
        <input name="reason" type="text" maxlength="500" autocomplete="off"
               placeholder="Where, how, and who witnessed it" />
      </label>
      <div class="actions">
        <button id="save-write-off" type="submit">Record it</button>
        <button id="cancel-write-off" type="button" class="secondary">Cancel</button>
      </div>
      <p class="note">This is the only record of why this material no longer exists, so the
        reason is what an inspector reads. Destroyed and written off are kept apart on
        purpose. If a depot would take this material back, send it back instead — a
        write-off destroys stock somebody could still use.</p>
    </form>
  </section>`;
}

/**
 * What this rep must get rid of, and by when.
 *
 * Three states per row, and naming them is the whole value of the section:
 *
 *   - a deadline still ahead, or already past (the server's own `status` and `days_overdue`);
 *   - a write-off QUEUED on this device, so the rep does not do it twice — the second would
 *     be refused for insufficient stock, or worse, succeed against a different carton;
 *   - the material GONE but the obligation still open, because the nightly sweep is what
 *     closes it. That lag is real and the screen says so rather than showing a deadline for
 *     something already dealt with. The record itself is not late: 0057 made the sweep
 *     record the date the material actually left.
 */
function renderObligations(now: number): string {
  if (state.obligations.length === 0) return "";
  const queued = new Set(
    state.outbox.filter((e) => e.kind === "write_off").map((e) => (e.kind === "write_off" ? e.body.lotId : "")),
  );
  return `<section>
    <h2>To dispose of (${state.obligations.length})</h2>
    <p class="note">Expired stock in a bag is the most common sample-audit finding there is.
      Cached ${ago(state.cachedAt, now)}.</p>
    <ul class="list">
      ${state.obligations
        .map((o) => {
          const gone = Number(o.quantity_on_hand) <= 0;
          const pending = queued.has(o.lot_id);
          const state_ = gone
            ? "dealt with — the nightly sweep will close this"
            : pending
              ? "recorded on this device, waiting to send"
              : o.days_overdue > 0
                ? `${o.days_overdue} day(s) OVERDUE`
                : `due ${o.due_by} (${Math.abs(o.days_overdue)} day(s) left)`;
          return `<li><span class="grow">
            <span class="name">${escapeHtml(o.lot_number)} · ${escapeHtml(o.erp_item_id)}</span>
            <span class="meta${o.days_overdue > 0 && !gone && !pending ? " error" : ""}">${escapeHtml(o.quantity_on_hand)} on hand · expired ${escapeHtml(o.expired_on)} · ${escapeHtml(state_)}</span>
          </span>
          ${gone || pending
            ? ""
            : `<button data-write-off="${escapeHtml(o.lot_id)}">Dispose of it</button>
               <button class="secondary" data-return="${escapeHtml(o.lot_id)}">Send back</button>`}</li>`;
        })
        .join("")}
    </ul>
  </section>`;
}

/**
 * Send material back to a depot.
 *
 * THE WAREHOUSE USED NOT TO BE A CHOICE, and the reason it now is one is the whole point of
 * this screen. The CRM modelled no warehouses, so the only destination a device could name
 * without inventing it was `last_received_from` — the depot that had demonstrably sent this
 * lot to this rep. Material handed over by a COLLEAGUE has no such receipt, so this form
 * used to say it did not know where the stock came from and offer the write-off instead:
 * destroying material a depot could have put back on a shelf, because the device could not
 * name the shelf.
 *
 * `GET /v1/samples/warehouses` (0058) removed that. The device offers the depots the ERP
 * says are open, with the lot's own origin pre-selected when it has one and is still open,
 * and the server checks the choice against the same list.
 *
 * NOTHING IS PRE-SELECTED OTHERWISE. A default depot would be a guess with a lorry attached,
 * and the one thing worse than making a rep choose is choosing wrong for them.
 *
 * With an EMPTY list — a device whose cache predates the list, or one that has never been
 * online since it appeared — the old behaviour stands exactly as it was: the origin depot
 * is shown rather than offered, and a transfer-received lot still cannot be returned. That
 * is a worse screen than the list gives, and it is never a worse screen than before.
 */
function renderReturnForm(holding: Holding, now: number): string {
  const from = holding.last_received_from ?? null;
  const depots = state.warehouses;
  const fromIsOpen = from !== null && depots.some((w) => w.erp_warehouse_id === from);

  const noList = `<p class="warn">This device has no list of depots yet${
    from === null
      ? ` — and this material reached you from a colleague rather than from a depot, so
         there is no warehouse to send it back to. Connect once to fetch the list, or write
         it off.`
      : `, so the only destination it can name is where this lot came from.`
  }</p>`;

  const options = [
    `<option value="" ${fromIsOpen ? "" : "selected"}>Choose a depot…</option>`,
    ...depots.map(
      (w) =>
        `<option value="${escapeHtml(w.erp_warehouse_id)}" ${w.erp_warehouse_id === from ? "selected" : ""}>${escapeHtml(w.code)} — ${escapeHtml(w.name)}${w.city === null || w.city === undefined || w.city === "" ? "" : ` (${escapeHtml(w.city)})`}${w.erp_warehouse_id === from ? " · where this lot came from" : ""}</option>`,
    ),
  ].join("");

  const quantityAndReason = `<label>Quantity (of ${escapeHtml(holding.quantity_on_hand)})
            <input name="quantity" type="text" inputmode="decimal" autocomplete="off" placeholder="how much" />
          </label>
          <label>Reason
            <input name="reason" type="text" maxlength="500" autocomplete="off"
                   placeholder="Why it is going back — optional, and read by whoever receives it" />
          </label>`;

  const mirrorNote = `<p class="note">This is the one thing you record that the ERP has to be told about:
            the stock re-enters the depot's own books. If that message fails, it shows up
            below as something the ERP has not been told — the return itself is still
            recorded here either way.</p>`;

  return `<section>
    <h2>Back to a depot — ${escapeHtml(holding.lot_number)}</h2>
    ${depots.length === 0
      ? from === null
        ? `${noList}
         <div class="actions"><button id="cancel-return" type="button" class="secondary">Back</button></div>`
        : `<form id="return-form">
          ${noList}
          <p class="note">Going back to <strong>${escapeHtml(from)}</strong> — the depot this
            lot came from.</p>
          ${quantityAndReason}
          <div class="actions">
            <button id="save-return" type="submit">Record the return</button>
            <button id="cancel-return" type="button" class="secondary">Cancel</button>
          </div>
          ${mirrorNote}
        </form>`
      : `<form id="return-form">
          <label>Depot
            <select name="warehouse">${options}</select>
          </label>
          ${from !== null && !fromIsOpen
            ? `<p class="warn">This lot came from ${escapeHtml(from)}, which is not in the list
                 of open depots — it may have closed, or the list may be older than it is.
                 Pick where the stock is actually going.</p>`
            : from === null
              ? `<p class="note">This material reached you from a colleague, so there is no
                   depot it came from. Pick the one taking it back.</p>`
              : ""}
          ${quantityAndReason}
          <div class="actions">
            <button id="save-return" type="submit">Record the return</button>
            <button id="cancel-return" type="button" class="secondary">Cancel</button>
          </div>
          <p class="note">${depots.length} depot(s), as the ERP had them ${escapeHtml(ago(state.cachedAt, now))}.
            A depot that has closed since is refused when this sends, with the reason attached.</p>
          ${mirrorNote}
        </form>`}
  </section>`;
}

/**
 * The rule this rep is held to, and who decided it.
 *
 * READ-ONLY FOR ALMOST EVERYONE, and that is the point rather than a limitation. The grace
 * period and the promo auto-write-off switch are the SOP parameters every rep in the tenant
 * is measured against; `GET /v1/samples/disposal-policy` is open to all of them for exactly
 * that reason, and the write needs the `compliance` grant. So this section shows the policy
 * to anybody and the form to the two or three people who may change it.
 *
 * THE PROVENANCE IS NOT DECORATION. "Thirty days" is not an answer to "what am I held to"
 * without who set it, when, and why — and before 0059 there was nothing to show, because the
 * write was an `UPDATE … SET grace_days = 7` that moved a timestamp. "Nobody has changed
 * this" is printed as itself rather than as a blank: a device that said "set by —" would
 * imply somebody had.
 */
function renderPolicy(now: number): string {
  const policy = state.policy;
  if (policy === null) {
    // Said rather than guessed. A device that printed the shipped default before it had
    // asked would be stating a tenant-wide rule it has never been told.
    return `<section>
      <h2>Disposal policy</h2>
      <p class="note">This device has not been told the tenant's disposal policy yet. Connect
        once and it will say how long you have to dispose of expired stock.</p>
    </section>`;
  }
  const mayChange = state.roles.includes("compliance");
  const provenance =
    policy.changed_by_name === null || policy.changed_by_name === undefined
      ? `<p class="note">Nobody has changed this: it is the default this system ships with.</p>`
      : `<p class="note">Set by <strong>${escapeHtml(policy.changed_by_name)}</strong> on
           ${escapeHtml(String(policy.changed_at ?? "").slice(0, 10))}${
             policy.reason === null || policy.reason === undefined
               ? ""
               : ` — “${escapeHtml(policy.reason)}”`
           }</p>`;
  return `<section>
    <h2>Disposal policy</h2>
    <ul class="list">
      <li><span class="grow">
        <span class="name">${policy.grace_days} day(s) to dispose of expired stock</span>
        <span class="meta">from the day the nightly sweep finds it in your bag. A deadline you
          have already been given never moves when this changes.</span>
      </span></li>
      <li><span class="grow">
        <span class="name">Promotional material ${policy.auto_writeoff_promo ? "is" : "is not"} written off automatically</span>
        <span class="meta">${policy.auto_writeoff_promo
          ? "a leaflet past its campaign date is written off by the nightly job. Drug samples never are."
          : "nothing leaves a balance without a person recording it."}</span>
      </span></li>
    </ul>
    ${provenance}
    <p class="note">Cached ${ago(state.cachedAt, now)}.</p>
    ${renderPolicyHistory()}
    ${mayChange
      ? `<div class="actions"><button id="edit-policy" ${state.online ? "" : "disabled"}>Change it</button></div>
         ${state.online
           ? ""
           : `<p class="note">Changing it needs a network: it is a decision about a
                tenant-wide rule rather than a record of something that happened, so this
                device does not queue it. A queued policy change would take effect whenever
                a phone next found signal, and would overwrite a colleague's.</p>`}`
      : ``}
  </section>`;
}

/** The last few changes, which is how a rep knows what they were held to in March. */
function renderPolicyHistory(): string {
  if (state.policyChanges.length === 0) return "";
  return `<details>
    <summary>How it got here (${state.policyChanges.length})</summary>
    <ul class="list">
      ${state.policyChanges
        .map((c) => {
          const parts: string[] = [];
          if (c.grace_days_from !== c.grace_days_to) {
            parts.push(`${c.grace_days_from} → ${c.grace_days_to} day(s)`);
          }
          if (c.auto_writeoff_promo_from !== c.auto_writeoff_promo_to) {
            parts.push(`promo auto-write-off ${c.auto_writeoff_promo_to ? "on" : "off"}`);
          }
          return `<li><span class="grow">
            <span class="name">${escapeHtml(parts.join(", "))}</span>
            <span class="meta">${escapeHtml(c.changed_by_name)} · ${escapeHtml(c.changed_at.slice(0, 10))} · ${escapeHtml(c.reason)}</span>
          </span></li>`;
        })
        .join("")}
    </ul>
  </details>`;
}

/**
 * Who changed this tenant's settings, and why (0061).
 *
 * ADMINISTRATOR ONLY, and absent rather than empty for everyone else: a section headed
 * "configuration history" with nothing under it reads as "nobody has ever changed anything",
 * which is a claim this device has not been told and has no way to check.
 *
 * GENERIC ON PURPOSE, and this is where 0061's jsonb pays for itself and also shows its cost.
 * The disposal policy above draws "30 → 7 day(s)" because its log has typed columns for
 * exactly those two parameters. This one renders whichever tables are under attribution, so it
 * can only say "`retain_read_days`: 30 → 7" — the column name as the database spells it. That
 * is honest for an administrator reading their own settings and it is NOT what you would put
 * in front of a rep, which is the whole reason 0059's log was not converted to this shape.
 *
 * Both values are read THROUGH `changed_columns` rather than by walking the documents: the
 * records carry the whole row before and after, and a client that iterated them would print
 * every column the table has, including the dozen nobody touched.
 */
function renderConfigHistory(): string {
  if (!state.roles.includes("administrator")) return "";
  if (state.configChanges.length === 0) {
    return `<section>
      <h2>Configuration history</h2>
      <p class="note">Nothing in this tenant's settings has been changed. Every change to the
        notification horizons or the expense account map is recorded here with who made it and
        why — the database refuses one that names nobody.</p>
    </section>`;
  }
  return `<section>
    <h2>Configuration history</h2>
    <ul class="list">
      ${state.configChanges.map(renderConfigChange).join("")}
    </ul>
    <p class="note">The five most recent. Each one names the row it changed, every column that
      moved, and the sentence its author gave.</p>
  </section>`;
}

/** One record: what moved, from what to what, by whom, and why. */
function renderConfigChange(change: ConfigChange): string {
  const moved = change.changed_columns
    .map((column) => {
      const after = renderConfigValue(change.after[column]);
      // A creation has no `before`, which `action` also says. Printing "null → 6200" there
      // would invent a previous value for a row that had none.
      if (change.before === null || change.before === undefined) return `${column}: ${after}`;
      return `${column}: ${renderConfigValue(change.before[column])} → ${after}`;
    })
    .join(" · ");
  const key = Object.entries(change.row_key)
    // The tenant is every row's key here and saying so on every line tells an administrator
    // nothing they do not already know about the tenant they are signed into.
    .filter(([column]) => column !== "tenant_id")
    .map(([column, value]) => `${column} ${renderConfigValue(value)}`)
    .join(", ");
  const subject = key === "" ? change.table_name : `${change.table_name} (${key})`;
  return `<li><span class="grow">
    <span class="name">${escapeHtml(subject)}</span>
    <span class="meta">${escapeHtml(moved)}</span>
    <span class="meta">${escapeHtml(change.changed_by_name)} · ${escapeHtml(change.changed_at.slice(0, 10))} · ${escapeHtml(change.reason)}</span>
  </span></li>`;
}

/**
 * One jsonb value, as a person reads it.
 *
 * `JSON.stringify` for anything that is not a string, number or boolean, because the
 * alternative is `[object Object]` on screen. `null` is printed as the word rather than as a
 * blank: in a before/after pair a blank would read as "and then nothing", when the fact being
 * recorded is that the column held no value.
 */
function renderConfigValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Change the policy — which means stating why.
 *
 * THE REASON FIELD IS THE INCREMENT. The role model (0023) answered who may change these
 * parameters and left the record of what happened where it found it: an UPDATE that moved
 * `updated_at`. So the form cannot be submitted without a reason, the server refuses one
 * shorter than ten characters, and the change lands as a row in an append-only log that the
 * policy itself is a projection of.
 *
 * Both fields are pre-filled with what is in force, so a change to one knob does not silently
 * restate the other — and the form shows the current values rather than empty boxes, because
 * "what is it now" is the first thing somebody about to change it needs.
 */
function renderPolicyForm(): string {
  const policy = state.policy;
  if (policy === null) return "";
  return `<section>
    <h2>Change the disposal policy</h2>
    <p class="note">These are the SOP parameters every rep in this tenant is measured
      against. A deadline already communicated does not move: the grace period is copied
      onto each obligation when the sweep finds the stock.</p>
    <form id="policy-form">
      <label>Days to dispose of expired stock
        <input name="graceDays" type="text" inputmode="numeric" autocomplete="off"
               value="${policy.grace_days}" />
      </label>
      <label>Write off expired promotional material automatically
        <select name="autoWriteoffPromo">
          <option value="no" ${policy.auto_writeoff_promo ? "" : "selected"}>No — a person records every write-off</option>
          <option value="yes" ${policy.auto_writeoff_promo ? "selected" : ""}>Yes — the nightly job writes off expired leaflets</option>
        </select>
      </label>
      <label>Why — required
        <input name="reason" type="text" maxlength="1000" autocomplete="off"
               placeholder="What changed, and on whose authority" />
      </label>
      <div class="actions">
        <button id="save-policy" type="submit">Record the change</button>
        <button id="cancel-policy" type="button" class="secondary">Cancel</button>
      </div>
      <p class="note">Your name and the values now in force are recorded with it, and the
        record cannot be edited afterwards. Drug samples are never written off by a job
        whatever this says — only promotional material.</p>
    </form>
  </section>`;
}

/**
 * Writes the ERP will never hear about unless somebody retries them.
 *
 * THE SECTION A RETURN MADE NECESSARY. Everything else a rep records is CRM-only, so a
 * landed row meant the job was done. A return puts stock back into a warehouse's books, and
 * the route answers 201 whether or not the mirror to the ERP enqueued — deliberately,
 * because the CRM ledger IS correct and a 4xx would tell the rep their return was not
 * written when it was. The consequence is that "accepted" stops meaning "finished", and the
 * only honest thing a device can do is show the difference.
 *
 * The retry needs a network, unlike every other action here: it is a request to a queue
 * that lives on the server, where nothing happens offline anyway.
 */
function renderFailedErpWrites(now: number): string {
  if (state.failedErpWrites.length === 0) return "";
  return `<section>
    <h2>The ERP has not been told (${state.failedErpWrites.length})</h2>
    <p class="warn">These were recorded here and the ERP never accepted them. The records are
      safe; the ERP's own stock figures are not up to date until these go through.</p>
    <ul class="list">
      ${state.failedErpWrites
        .map(
          (w) => `<li><span class="grow">
            <span class="name">${escapeHtml(w.entity)} ${escapeHtml(w.operation)}</span>
            <span class="meta error">${escapeHtml(w.dead_reason ?? "no reason recorded")} · ${w.attempts} attempt(s)${w.revive_count > 0 ? ` · retried ${w.revive_count}×` : ""}</span>
          </span>
          <button class="secondary" data-retry-erp="${escapeHtml(w.id)}" ${state.online ? "" : "disabled"}>Try again</button></li>`,
        )
        .join("")}
    </ul>
    <p class="note">Cached ${ago(state.cachedAt, now)}. Trying again re-sends the same
      message, which helps when the ERP side has changed and not when the message itself is
      wrong — it is not an edit.${state.online ? "" : " Needs a network."}</p>
  </section>`;
}

function renderVisitForm(account: Account): string {
  return `<section>
    <h2>Visit — ${escapeHtml(text(account.name, account.erp_account_id))}</h2>
    <form id="visit-form">
      <div class="row">
        <label>Type
          <select name="visitType">
            <option value="detailing">Detailing</option>
            <option value="follow_up">Follow-up</option>
            <option value="sample_drop">Sample drop</option>
            <option value="training">Training</option>
            <option value="cycle_meeting">Cycle meeting</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>Outcome
          <select name="outcome">
            <option value="successful">Successful</option>
            <option value="no_access">No access</option>
            <option value="rescheduled">Rescheduled</option>
            <option value="declined">Declined</option>
          </select>
        </label>
        <label>Minutes
          <input name="durationMinutes" type="number" min="0" max="1440" inputmode="numeric" value="15" />
        </label>
      </div>
      <label>Notes
        <textarea name="notes" maxlength="10000" placeholder="What was discussed"></textarea>
      </label>
      <label class="note" style="flex-direction:row; display:flex; gap:.5rem; align-items:center">
        <input id="use-location" type="checkbox" style="width:auto" /> attach my location
      </label>
      <div class="actions">
        <button id="save-visit" type="submit">Save visit</button>
        <button id="cancel-visit" type="button" class="secondary">Cancel</button>
      </div>
      <p class="note">Saved on this device first. It syncs when there is a network, and
        nothing on this screen pretends otherwise.</p>
    </form>
  </section>`;
}

// ---- wiring ---------------------------------------------------------------

function on(id: string, event: string, handler: (e: Event) => void): void {
  document.getElementById(id)?.addEventListener(event, handler);
}

function wireLogin(): void {
  on("login", "click", () => {
    void (async () => {
      const config = state.config;
      if (config === null) return;
      try {
        const url = await beginLogin(
          {
            issuer: config.oidc.issuer,
            clientId: config.oidc.clientId,
            redirectUri: new URL("./", location.href).toString(),
            scope: config.oidc.scope,
            ...(config.oidc.audience !== undefined ? { audience: config.oidc.audience } : {}),
          },
          { storage: sessionStorageAuth() },
        );
        location.assign(url);
      } catch (err) {
        state.message = { kind: "error", text: `Sign-in could not start: ${(err as Error).message}` };
        render();
      }
    })();
  });

  if (__DEV_TOKEN_LOGIN__) {
    on("dev-login", "click", () => {
      const token = (document.getElementById("dev-token") as HTMLInputElement | null)?.value.trim() ?? "";
      const tenant = (document.getElementById("dev-tenant") as HTMLInputElement | null)?.value.trim() ?? "";
      if (token === "") {
        state.message = { kind: "error", text: "Paste a token first." };
        render();
        return;
      }
      // One hour, arbitrarily: a dev token's real expiry is in the token, and this path
      // exists to drive the app in a test rather than to manage a session.
      const session: Session = {
        accessToken: token,
        expiresAt: Date.now() + 3_600_000,
        ...(tenant !== "" ? { tenantId: tenant } : {}),
      };
      adoptSession(session);
    });
  }
}

function wireReady(): void {
  on("sync", "click", () => void drain({ manual: true }));
  on("refresh", "click", () => void refreshReference());
  on("cancel-visit", "click", () => {
    state.recording = null;
    formDraft = null;
    render();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-visit]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["visit"];
      state.recording = state.accounts.find((a) => a.erp_account_id === id) ?? null;
      formDraft = null;
      state.message = null;
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-disburse]")) {
    button.addEventListener("click", () => {
      const lotId = button.dataset["disburse"];
      state.disbursing = state.holdings.find((h) => h.lot_id === lotId) ?? null;
      state.message = null;
      // A fresh form starts blank. Every exit from the form already clears this, so the
      // line is belt and braces — but it keeps the invariant local to the form's opening
      // rather than resting on every path out of it staying correct.
      signatureInProgress = null;
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-return]")) {
    button.addEventListener("click", () => {
      const lotId = button.dataset["return"];
      const holding = state.holdings.find((h) => h.lot_id === lotId) ?? null;
      if (holding === null) {
        state.message = { kind: "warn", text: "This device has no balance cached for that lot. Refresh while there is a network." };
        render();
        return;
      }
      formDraft = null;
      state.returning = holding;
      state.message = null;
      render();
    });
  }
  on("cancel-return", "click", () => {
    formDraft = null;
    state.returning = null;
    render();
  });
  document.getElementById("return-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveReturn(event.target as HTMLFormElement);
  });
  on("edit-policy", "click", () => void openPolicyForm());
  on("cancel-policy", "click", () => {
    formDraft = null;
    state.editingPolicy = false;
    render();
  });
  document.getElementById("policy-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void savePolicy(event.target as HTMLFormElement);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-retry-erp]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["retryErp"];
      if (id !== undefined) void retryErpWrite(id);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-write-off]")) {
    button.addEventListener("click", () => {
      const lotId = button.dataset["writeOff"];
      const holding = state.holdings.find((h) => h.lot_id === lotId) ?? null;
      if (holding === null) {
        // An obligation for a lot this device has no holding for. It can happen: the
        // obligation list and the holdings are two reads, and a write-off needs the
        // quantity, so this says so rather than opening a form with no balance in it.
        state.message = { kind: "warn", text: "This device has no balance cached for that lot. Refresh while there is a network." };
        render();
        return;
      }
      formDraft = null;
      state.writingOff = {
        holding,
        // Which button was pressed decides the default KIND, because the two entry points
        // mean different things: from a disposal obligation it is expired stock, and from
        // the stock list it is usually something damaged.
        because: state.obligations.some((o) => o.lot_id === lotId) ? "expired" : "chosen",
      };
      state.message = null;
      render();
    });
  }
  on("cancel-write-off", "click", () => {
    state.writingOff = null;
    formDraft = null;
    render();
  });
  document.getElementById("write-off-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveWriteOff(event.target as HTMLFormElement);
  });

  on("start-count", "click", () => {
    state.counting = true;
    formDraft = null;
    state.message = null;
    render();
  });
  on("cancel-count", "click", () => {
    state.counting = false;
    formDraft = null;
    render();
  });
  document.getElementById("count-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCount(event.target as HTMLFormElement);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-discard-count]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["discardCount"];
      if (id !== undefined) void discardQueuedCount(id);
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-cancel-count]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["cancelCount"];
      if (id !== undefined) void abandonOpenCount(id);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-transfer]")) {
    button.addEventListener("click", () => {
      const lotId = button.dataset["transfer"];
      state.transferring = state.holdings.find((h) => h.lot_id === lotId) ?? null;
      formDraft = null;
      state.message = null;
      render();
    });
  }
  on("cancel-transfer", "click", () => {
    state.transferring = null;
    formDraft = null;
    render();
  });
  document.getElementById("transfer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveTransfer(event.target as HTMLFormElement);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-accept]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["accept"];
      if (id !== undefined) void acceptIncoming(id);
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-recall]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["recall"];
      if (id !== undefined) void recallSent(id);
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-unsend]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["unsend"];
      if (id !== undefined) void unsendTransfer(id);
    });
  }

  on("cancel-disbursement", "click", () => {
    state.disbursing = null;
    formDraft = null;
    signatureInProgress = null;
    pad?.detach();
    pad = null;
    render();
  });
  on("clear-signature", "click", () => {
    signatureInProgress = null;
    pad?.clear();
  });

  const canvas = document.getElementById("signature-pad");
  if (canvas instanceof HTMLCanvasElement) {
    pad?.detach();
    pad = createSignaturePad(canvas, signatureInProgress !== null ? { restore: signatureInProgress } : {});
  }
  document.getElementById("disburse-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveDisbursement(event.target as HTMLFormElement);
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-discard]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["discard"];
      void (async () => {
        if (store === null || id === undefined) return;
        // A discard is a decision, so it happens only on a click — the app never discards
        // anything on its own. It DOES take dependents with it: a signature whose
        // disbursement has been thrown away can never be filed, and leaving it would make
        // it due the moment its prerequisite vanished, then refused with a 404 that says
        // nothing about what actually happened.
        state.outbox = state.outbox.filter((e) => e.id !== id && !(e.dependsOn ?? []).includes(id));
        await store.replaceOutbox(state.outbox);
        render();
      })();
    });
  }

  document.getElementById("visit-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveVisit(event.target as HTMLFormElement);
  });
}

// ---- actions --------------------------------------------------------------

async function saveVisit(form: HTMLFormElement): Promise<void> {
  const account = state.recording;
  if (account === null || store === null) return;

  const data = new FormData(form);
  const minutes = Number(data.get("durationMinutes"));
  const useLocation = (document.getElementById("use-location") as HTMLInputElement | null)?.checked === true;

  const checkin = useLocation ? await currentPosition() : null;

  const candidate = {
    // Minted HERE, before any network exists. The server upserts by it, so a replay
    // after a dropped connection lands on the same row rather than filing twice.
    id: mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) }),
    erpAccountId: account.erp_account_id,
    visitType: String(data.get("visitType") ?? "detailing"),
    status: "completed",
    occurredAt: new Date().toISOString(),
    outcome: String(data.get("outcome") ?? "successful"),
    durationMinutes: Number.isFinite(minutes) ? Math.trunc(minutes) : null,
    notes: String(data.get("notes") ?? "").trim() === "" ? null : String(data.get("notes")),
    ...(checkin !== null ? { checkin } : {}),
  };

  // Validated against the API's own schema before it is queued. A body the server would
  // refuse must never enter the outbox: inside a batch it comes back as
  // `validation_failed` hours later, which a rep cannot act on and cannot even see.
  const parsed = VisitBody.safeParse(candidate);
  if (!parsed.success) {
    state.message = {
      kind: "error",
      text: `This visit cannot be saved: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
    render();
    return;
  }

  const author = authorId();
  if (author === null) {
    state.message = { kind: "error", text: "This device does not know who is signed in yet, so it cannot record who made this visit. Connect once and try again." };
    render();
    return;
  }
  state.outbox = enqueueVisit(state.outbox, parsed.data, Date.now(), { createdBy: author });
  await store.replaceOutbox(state.outbox);
  state.recording = null;
  formDraft = null;
  state.message = { kind: "good", text: "Saved on this device. It will sync when there is a network." };
  render();
  void drain({ manual: false });
}

/**
 * Record a disbursement: two queued rows, in an order the engine knows about.
 *
 * The signature is hashed HERE, once, from the same bytes that go into the second row —
 * so the digest the ledger commits to and the image that is uploaded agree by
 * construction rather than by a later comparison. The server recomputes it and answers
 * `signature_mismatch` if they ever disagree, and that refusal is permanent, which is why
 * it must not be possible to produce one by accident.
 */
async function saveDisbursement(form: HTMLFormElement): Promise<void> {
  const holding = state.disbursing;
  if (holding === null || store === null) return;

  if (pad === null || pad.isEmpty()) {
    state.message = { kind: "error", text: "A signature is required: the ledger row commits to it." };
    render();
    return;
  }

  const data = new FormData(form);
  const recipientName = String(data.get("recipientName") ?? "").trim();
  const quantity = String(data.get("quantity") ?? "").trim();

  let signature;
  try {
    signature = await capture(await pad.toPng());
  } catch (err) {
    state.message = { kind: "error", text: (err as Error).message };
    render();
    return;
  }

  const disbursementId = mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) });
  const candidate = {
    id: disbursementId,
    lotId: holding.lot_id,
    quantity,
    occurredAt: new Date().toISOString(),
    erpAccountId: String(data.get("erpAccountId") ?? ""),
    recipientName,
    signatureSha256: signature.sha256,
  };

  // Validated against the API's own schema before anything is queued. A quantity with
  // four decimals, or an empty recipient, must fail at the keyboard: inside a batch it
  // comes back as `validation_failed` hours later, which a rep cannot act on.
  const parsed = DisbursementBody.safeParse(candidate);
  if (!parsed.success) {
    state.message = {
      kind: "error",
      text: `This disbursement cannot be saved: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
    render();
    return;
  }

  const author = authorId();
  if (author === null) {
    state.message = { kind: "error", text: "This device does not know who is signed in yet, so it cannot record who handed this over. Connect once and try again." };
    render();
    return;
  }
  const signatureId = mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) });
  let queue = enqueueDisbursement(state.outbox, parsed.data, Date.now(), { createdBy: author });
  queue = enqueueSignature(
    queue,
    { id: signatureId, contentType: signature.contentType, contentBase64: signature.base64 },
    Date.now(),
    { createdBy: author, disbursementId },
  );
  state.outbox = queue;
  await store.replaceOutbox(state.outbox);

  // The holding on screen is decremented optimistically, so a rep disbursing twice from
  // one lot is not offered stock the first disbursement has already spent. The server is
  // the authority and `refreshReference` replaces this the moment there is a network.
  const remaining = Number(holding.quantity_on_hand) - Number(quantity);
  state.holdings = state.holdings.map((h) =>
    h.lot_id === holding.lot_id
      ? {
          ...h,
          // `toFixed(3)` to match the column's own spelling. The server sends numeric(16,3)
          // as text — "10.000" — and `String(8)` would put "8" on the same screen for the
          // same kind of number, which reads as two different units.
          quantity_on_hand: Number.isFinite(remaining) ? Math.max(0, remaining).toFixed(3) : h.quantity_on_hand,
        }
      : h,
  );

  pad.detach();
  pad = null;
  signatureInProgress = null;
  formDraft = null;
  state.disbursing = null;
  state.message = {
    kind: "good",
    text: "Saved on this device: the disbursement, then its signature. Both sync when there is a network.",
  };
  render();
  void drain({ manual: false });
}

/**
 * Hand a quantity to a colleague: one queued movement, and the balance moved on screen.
 *
 * Nothing waits on anything here. A transfer is a single route that answers 201, so unlike
 * a disbursement there is no second half to order — the receiver's acceptance happens on
 * THEIR device, and the sender's screen stops being responsible for it the moment this row
 * lands.
 */
async function saveTransfer(form: HTMLFormElement): Promise<void> {
  const holding = state.transferring;
  const author = authorId();
  if (holding === null || store === null) return;
  if (author === null) {
    state.message = { kind: "error", text: "This device does not know who is signed in yet, so it cannot record who sent this. Connect once and try again." };
    render();
    return;
  }

  const data = new FormData(form);
  const quantity = String(data.get("quantity") ?? "").trim();
  const toRepProfileId = String(data.get("toRepProfileId") ?? "");

  const parsed = TransferBody.safeParse({
    id: mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) }),
    lotId: holding.lot_id,
    quantity,
    occurredAt: new Date().toISOString(),
    toRepProfileId,
  });
  if (!parsed.success) {
    state.message = {
      kind: "error",
      text: `This transfer cannot be saved: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
    render();
    return;
  }

  // At the keyboard, not as a queued refusal hours later: the database refuses a transfer
  // of more than the rep holds (`InsufficientHoldingError` → 409), and a rep who finds
  // that out from a sync report has already told a colleague the material is coming.
  //
  // Checked against the LIVE holding rather than the snapshot the form was opened with.
  // A drain that settles another movement refreshes the balances, and a form left open
  // across that would otherwise be judged against a number that is no longer true — in
  // either direction: refusing a transfer that now fits, or queueing one that no longer
  // does.
  const live = state.holdings.find((h) => h.lot_id === holding.lot_id) ?? holding;
  if (Number(quantity) > Number(live.quantity_on_hand)) {
    state.message = {
      kind: "error",
      text: `You are carrying ${live.quantity_on_hand} of ${live.lot_number}, so ${quantity} cannot be sent.`,
    };
    render();
    return;
  }

  state.outbox = enqueueTransfer(state.outbox, parsed.data, Date.now(), { createdBy: author });
  await store.replaceOutbox(state.outbox);

  // Optimistic, and in BOTH columns: the quantity leaves `on_hand` and appears
  // `in_transit`, which is exactly what the ledger's trigger will do. Showing only the
  // decrement would make the material look lost until the next refresh.
  const onHand = Number(live.quantity_on_hand) - Number(quantity);
  const inTransit = Number(live.quantity_in_transit) + Number(quantity);
  state.holdings = state.holdings.map((h) =>
    h.lot_id === holding.lot_id
      ? {
          ...h,
          quantity_on_hand: Number.isFinite(onHand) ? Math.max(0, onHand).toFixed(3) : h.quantity_on_hand,
          quantity_in_transit: Number.isFinite(inTransit) ? inTransit.toFixed(3) : h.quantity_in_transit,
        }
      : h,
  );

  state.transferring = null;
  formDraft = null;
  state.message = {
    kind: "good",
    text: `Saved on this device: ${quantity} of ${holding.lot_number} to ${nameOfPeer(toRepProfileId)}. It syncs when there is a network.`,
  };
  render();
  void drain({ manual: false });
}

/**
 * Accept material a colleague sent.
 *
 * The body carries this movement's own id and a clock and nothing else: the lot and the
 * quantity are read off the transfer by the server, so an acceptance cannot disagree with
 * what was sent. The transfer's id goes in the path.
 */
async function acceptIncoming(transferId: string): Promise<void> {
  const author = authorId();
  if (store === null || author === null) return;
  const transfer = state.incoming.find((t) => t.transaction_id === transferId);
  if (transfer === undefined) return;

  const parsed = AcceptBody.safeParse({
    id: mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) }),
    occurredAt: new Date().toISOString(),
  });
  if (!parsed.success) return;

  state.outbox = enqueueAcceptance(state.outbox, parsed.data, Date.now(), {
    createdBy: author,
    transferOf: transferId,
  });
  await store.replaceOutbox(state.outbox);

  // The lot may be one this rep has never carried, so there is no row to increment —
  // which is why the optimistic update ADDS a holding when it is missing rather than
  // skipping it. Without that, accepting offline shows nothing at all until a refresh.
  const existing = state.holdings.find((h) => h.lot_id === transfer.lot_id);
  state.holdings =
    existing === undefined
      ? [
          ...state.holdings,
          {
            rep_profile_id: author,
            lot_id: transfer.lot_id,
            erp_item_id: transfer.erp_item_id,
            lot_number: transfer.lot_number,
            expiry_date: transfer.expiry_date,
            // Not carried by the transfer row, and not guessable: shown as unknown rather
            // than asserted, and the next refresh replaces the whole list anyway.
            material_kind: "unknown",
            quantity_on_hand: Number(transfer.quantity).toFixed(3),
            quantity_in_transit: "0.000",
          },
        ]
      : state.holdings.map((h) =>
          h.lot_id === transfer.lot_id
            ? { ...h, quantity_on_hand: (Number(h.quantity_on_hand) + Number(transfer.quantity)).toFixed(3) }
            : h,
        );

  state.message = {
    kind: "good",
    text: `Saved on this device: accepting ${transfer.quantity} of ${transfer.lot_number} from ${transfer.sent_by_name}.`,
  };
  render();
  void drain({ manual: false });
}

/** Take back material nobody accepted. A new movement, never an edit. */
async function recallSent(transferId: string): Promise<void> {
  const author = authorId();
  if (store === null || author === null) return;
  const transfer = state.recallable.find((t) => t.transaction_id === transferId);
  if (transfer === undefined) return;

  const parsed = RecallBody.safeParse({
    id: mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) }),
    occurredAt: new Date().toISOString(),
  });
  if (!parsed.success) return;

  // `transferUnsent` only when this device is still holding the transfer itself. The
  // screen offers "Cancel" rather than "Recall" in that case, so reaching here with an
  // unsent transfer means the lists disagreed — and the dependency is what keeps the
  // recall from drawing a 404 that is only ever about order.
  const unsent = state.outbox.some((e) => e.kind === "transfer" && e.id === transferId);
  state.outbox = enqueueRecall(state.outbox, parsed.data, Date.now(), {
    createdBy: author,
    transferOf: transferId,
    ...(unsent ? { transferUnsent: true } : {}),
  });
  await store.replaceOutbox(state.outbox);

  const back = state.holdings.find((h) => h.lot_id === transfer.lot_id);
  if (back !== undefined) {
    state.holdings = state.holdings.map((h) =>
      h.lot_id === transfer.lot_id
        ? {
            ...h,
            quantity_on_hand: (Number(h.quantity_on_hand) + Number(transfer.quantity)).toFixed(3),
            quantity_in_transit: Math.max(0, Number(h.quantity_in_transit) - Number(transfer.quantity)).toFixed(3),
          }
        : h,
    );
  }

  state.message = {
    kind: "good",
    text: `Saved on this device: taking back ${transfer.quantity} of ${transfer.lot_number} from ${transfer.sent_to_name}.`,
  };
  render();
  void drain({ manual: false });
}

/**
 * Cancel a transfer this device has not sent yet.
 *
 * Not a recall: there is nothing to recall. The server has never heard of this transfer,
 * so discarding the queued row leaves no ledger movement at all — where a recall would
 * write two (out, then back) for material that never moved. The cascade takes any recall
 * queued against it, for the reason the discard path already does: a dependent whose
 * prerequisite has vanished would be due immediately and refused with a 404 that says
 * nothing about what happened.
 */
async function unsendTransfer(entryId: string): Promise<void> {
  const author = authorId();
  if (store === null) return;
  const entry = state.outbox.find((e) => e.id === entryId);
  if (entry === undefined || entry.kind !== "transfer") return;
  if (author !== null && entry.createdBy !== author) {
    state.message = { kind: "error", text: "That transfer was recorded under a different sign-in on this device." };
    render();
    return;
  }

  state.outbox = state.outbox.filter((e) => e.id !== entryId && !(e.dependsOn ?? []).includes(entryId));
  await store.replaceOutbox(state.outbox);

  // The quantity goes back where it was, since nothing ever left.
  state.holdings = state.holdings.map((h) =>
    h.lot_id === entry.body.lotId
      ? {
          ...h,
          quantity_on_hand: (Number(h.quantity_on_hand) + Number(entry.body.quantity)).toFixed(3),
          quantity_in_transit: Math.max(0, Number(h.quantity_in_transit) - Number(entry.body.quantity)).toFixed(3),
        }
      : h,
  );
  state.message = { kind: "good", text: "That transfer was never sent, so nothing was recorded anywhere." };
  render();

  // The arithmetic above assumes the balance on screen still carries the optimistic
  // deduction this transfer made. That holds while the device is offline, because a
  // refresh that fails changes nothing — but a transfer stuck behind a 500 could have had
  // the server's own numbers (which never knew about it) land in between, and adding the
  // quantity back would then overstate it. One read settles it where a read is possible.
  if (state.online && state.blocked === null && state.phase === "ready") {
    await refreshReference();
  }
}

/**
 * Record the count: one document, a line per lot the rep filled in, and the commit.
 *
 * Four things worth knowing about this function, each of which is a decision rather than a
 * mechanism:
 *
 *   - A BLANK FIELD IS NOT A ZERO. Only lots the rep typed a number into become lines, so a
 *     count of three lots out of eleven is a count of three lots and says so. Treating
 *     blanks as zero would write off eight lots nobody looked at.
 *   - THE DEVICE'S OWN FIGURE GOES WITH EACH LINE. It is what the rep was looking at when
 *     they counted, which for a count taken offline is not what the server will hold when
 *     the line lands — and the server keeps both rather than letting either overwrite the
 *     other (0056).
 *   - THE COMMIT WAITS FOR EVERY LINE, by naming them. A commit that went early would write
 *     adjustments for the lots that happened to arrive and leave the rest of the bag
 *     unreconciled, with the late lines landing against a closed count where nothing would
 *     ever reconcile them.
 *   - NOTHING IS SENT HERE. The three rows are queued and the engine drains them in order
 *     whenever there is a network, which is the whole reason a count can be taken where the
 *     stock is.
 */
async function saveCount(form: HTMLFormElement): Promise<void> {
  const author = authorId();
  if (store === null) return;
  if (author === null) {
    state.message = { kind: "error", text: "This device does not know who is signed in yet, so it cannot record who counted. Connect once and try again." };
    render();
    return;
  }

  const data = new FormData(form);
  const counted: { lotId: string; quantity: string; deviceExpected: string }[] = [];
  const bad: string[] = [];
  for (const holding of state.holdings) {
    const raw = String(data.get(`count:${holding.lot_id}`) ?? "").trim();
    if (raw === "") continue;
    if (!/^\d{1,13}(\.\d{1,3})?$/.test(raw)) {
      bad.push(`${holding.lot_number} ("${raw}")`);
      continue;
    }
    counted.push({ lotId: holding.lot_id, quantity: raw, deviceExpected: holding.quantity_on_hand });
  }

  if (bad.length > 0) {
    // At the keyboard. Inside a queue this is a `validation_failed` on one line hours
    // later, which refuses the commit and takes the whole count with it.
    state.message = { kind: "error", text: `These counts are not numbers the ledger can hold: ${bad.join(", ")}.` };
    render();
    return;
  }
  if (counted.length === 0) {
    state.message = { kind: "warn", text: "Nothing was counted, so there is nothing to record. Fill in at least one lot." };
    render();
    return;
  }

  const mint = (): string => mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) });
  const note = String(data.get("note") ?? "").trim();
  const countId = mint();
  const parsed = CountBody.safeParse({
    id: countId,
    countedAt: new Date().toISOString(),
    ...(note !== "" ? { note } : {}),
  });
  if (!parsed.success) {
    state.message = {
      kind: "error",
      text: `This count cannot be saved: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
    render();
    return;
  }

  let queue = enqueueCount(state.outbox, parsed.data, Date.now(), { createdBy: author });
  const lineIds: string[] = [];
  for (const line of counted) {
    queue = enqueueCountLine(
      queue,
      { lotId: line.lotId, countedQuantity: line.quantity, deviceExpectedQuantity: line.deviceExpected },
      Date.now(),
      { createdBy: author, countOf: countId },
    );
    lineIds.push(countLineKey(countId, line.lotId));
  }
  queue = enqueueCountCommit(queue, Date.now(), {
    createdBy: author,
    id: mint(),
    countOf: countId,
    lineIds,
  });
  state.outbox = queue;
  await store.replaceOutbox(state.outbox);

  // Optimistic, and it is the counted figure rather than an arithmetic adjustment: a count
  // asserts what is in the bag, and the commit will make the balance equal exactly that.
  // Lots the rep did not count are left alone, because nothing has been said about them.
  const byLot = new Map(counted.map((c) => [c.lotId, c.quantity]));
  state.holdings = state.holdings.map((h) => {
    const q = byLot.get(h.lot_id);
    return q === undefined ? h : { ...h, quantity_on_hand: Number(q).toFixed(3) };
  });

  state.counting = false;
  formDraft = null;
  state.message = {
    kind: "good",
    text: `Saved on this device: a count of ${counted.length} lot(s). It syncs as one document — the count, each line, then the commit.`,
  };
  render();
  void drain({ manual: false });
}

/** Throw away a count this device never sent. No ledger rows exist to undo. */
async function discardQueuedCount(countId: string): Promise<void> {
  if (store === null) return;
  const parts = partsOfCount(state.outbox, countId);
  if (parts.length === 0) return;
  state.outbox = discardCount(state.outbox, countId);
  await store.replaceOutbox(state.outbox);
  state.message = {
    kind: "good",
    text: `That count was never sent, so nothing was recorded anywhere. ${parts.length} queued row(s) discarded.`,
  };
  render();
  // The optimistic figures it wrote were a claim about the bag that is now withdrawn, and
  // only the server can say what the balances really are.
  if (state.online && state.blocked === null && state.phase === "ready") await refreshReference();
}

/**
 * Abandon a count the server holds open.
 *
 * The exit from the one state a rep can otherwise get stuck in: a count whose line was
 * refused stays open, and `uq_sample_count_one_open` then refuses every count afterwards.
 * Queued rather than sent directly, so it works from the car park where the problem is
 * discovered — and the server makes a repeated cancel mean the same thing as the first.
 */
async function abandonOpenCount(countId: string): Promise<void> {
  const author = authorId();
  if (store === null || author === null) return;
  state.outbox = enqueueCountCancel(state.outbox, Date.now(), {
    createdBy: author,
    id: mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) }),
    countOf: countId,
  });
  await store.replaceOutbox(state.outbox);
  state.message = { kind: "good", text: "Saved on this device: that count will be abandoned, and no adjustments written." };
  render();
  void drain({ manual: false });
}

/**
 * Record material leaving custody.
 *
 * The simplest write in this app and the one with the least margin: there is no second half
 * to wait for, nothing depends on it, and what it records is that regulated material no
 * longer exists. So everything that can be refused is refused here — an empty reason, a
 * quantity that is not a number the ledger can hold, more than the rep is carrying — rather
 * than hours later from inside a queue, where the rep has already put the box in a bin.
 */
async function saveWriteOff(form: HTMLFormElement): Promise<void> {
  const target = state.writingOff;
  const author = authorId();
  if (target === null || store === null) return;
  if (author === null) {
    state.message = { kind: "error", text: "This device does not know who is signed in yet, so it cannot record who disposed of this. Connect once and try again." };
    render();
    return;
  }

  const data = new FormData(form);
  const quantity = String(data.get("quantity") ?? "").trim();
  const reason = String(data.get("reason") ?? "").trim();
  const kind = String(data.get("kind") ?? "") as WriteOffKind;

  if (reason === "") {
    state.message = {
      kind: "error",
      text: "A reason is required: it is the only record of why this material no longer exists.",
    };
    render();
    return;
  }

  // The live holding, not the snapshot the form was opened with — a drain that settled
  // another movement refreshes the balances underneath an open form.
  const live = state.holdings.find((h) => h.lot_id === target.holding.lot_id) ?? target.holding;
  const parsed = WriteOffBody.safeParse({
    id: mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) }),
    lotId: live.lot_id,
    quantity,
    occurredAt: new Date().toISOString(),
    kind,
    reason,
  });
  if (!parsed.success) {
    state.message = {
      kind: "error",
      text: `This cannot be recorded: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
    render();
    return;
  }
  if (Number(quantity) <= 0) {
    state.message = { kind: "error", text: "Nothing was disposed of, so there is nothing to record." };
    render();
    return;
  }
  if (Number(quantity) > Number(live.quantity_on_hand)) {
    state.message = {
      kind: "error",
      text: `You are carrying ${live.quantity_on_hand} of ${live.lot_number}, so ${quantity} cannot be written off.`,
    };
    render();
    return;
  }

  state.outbox = enqueueWriteOff(state.outbox, parsed.data, Date.now(), { createdBy: author });
  await store.replaceOutbox(state.outbox);

  const remaining = Number(live.quantity_on_hand) - Number(quantity);
  state.holdings = state.holdings.map((h) =>
    h.lot_id === live.lot_id
      ? { ...h, quantity_on_hand: Number.isFinite(remaining) ? Math.max(0, remaining).toFixed(3) : h.quantity_on_hand }
      : h,
  );
  // The obligation's own `quantity_on_hand` comes from the holding, so the screen moves it
  // to "dealt with" the moment the row is queued — and the obligation stays listed, because
  // only the sweep can close it and saying otherwise would be a claim this device cannot
  // make.
  state.obligations = state.obligations.map((o) =>
    o.lot_id === live.lot_id
      ? { ...o, quantity_on_hand: Number.isFinite(remaining) ? Math.max(0, remaining).toFixed(3) : o.quantity_on_hand }
      : o,
  );

  state.writingOff = null;
  formDraft = null;
  state.message = {
    kind: "good",
    text: `Saved on this device: ${quantity} of ${live.lot_number} ${kind === "destruction" ? "destroyed" : "written off"}. It syncs when there is a network.`,
  };
  render();
  void drain({ manual: false });
}

/**
 * Record material going back to a depot.
 *
 * THE DESTINATION IS CHOSEN FROM A LIST AND NEVER TYPED. A free text field here would
 * invite a return addressed to a depot that does not exist: the server's `erp_record_id`
 * domain only checks the SHAPE of an id, so before the warehouse list the mistake surfaced
 * hours later as a dead letter in the relay queue — or not at all, if the id happened to
 * belong to a real depot at another site, which the ERP accepts and posts against.
 *
 * The chosen id is checked against the cached list here and again by the server against
 * the live snapshot. Both, deliberately: this one catches a tampered option before the
 * movement is queued, and the server's catches a depot that closed while the return sat in
 * the queue — which this device cannot know about and must not pretend to.
 */
async function saveReturn(form: HTMLFormElement): Promise<void> {
  const target = state.returning;
  const author = authorId();
  if (target === null || store === null) return;
  if (author === null) {
    state.message = { kind: "error", text: "This device does not know who is signed in yet, so it cannot record who returned this. Connect once and try again." };
    render();
    return;
  }

  const live = state.holdings.find((h) => h.lot_id === target.lot_id) ?? target;
  const data = new FormData(form);
  const quantity = String(data.get("quantity") ?? "").trim();
  const reason = String(data.get("reason") ?? "").trim();

  // The picked depot, or — on a device with no list — the one this lot came from, which is
  // the only destination such a device can name without inventing one.
  const picked = String(data.get("warehouse") ?? "").trim();
  const warehouse = picked !== "" ? picked : (state.warehouses.length === 0 ? live.last_received_from ?? null : null);
  if (warehouse === null) {
    state.message = {
      kind: "error",
      text:
        state.warehouses.length === 0
          ? "This device does not know which depot this material came from, so it cannot address a return."
          : "Pick the depot this material is going back to.",
    };
    render();
    return;
  }
  // A depot the list does not have would be refused by the server anyway; refusing it here
  // means the rep finds out while they are still looking at the form, and it is the one
  // check that catches an option that did not come from the list.
  if (state.warehouses.length > 0 && !state.warehouses.some((w) => w.erp_warehouse_id === warehouse)) {
    state.message = {
      kind: "error",
      text: `${warehouse} is not one of the depots this device knows about, so a return cannot be addressed to it.`,
    };
    render();
    return;
  }

  const parsed = ReturnBody.safeParse({
    id: mintUuidV7({ now: () => Date.now(), randomBytes: (b) => crypto.getRandomValues(b) }),
    lotId: live.lot_id,
    quantity,
    occurredAt: new Date().toISOString(),
    erpWarehouseId: warehouse,
    ...(reason !== "" ? { reason } : {}),
  });
  if (!parsed.success) {
    state.message = {
      kind: "error",
      text: `This return cannot be saved: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
    render();
    return;
  }
  if (Number(quantity) <= 0) {
    state.message = { kind: "error", text: "Nothing was sent back, so there is nothing to record." };
    render();
    return;
  }
  if (Number(quantity) > Number(live.quantity_on_hand)) {
    state.message = {
      kind: "error",
      text: `You are carrying ${live.quantity_on_hand} of ${live.lot_number}, so ${quantity} cannot be sent back.`,
    };
    render();
    return;
  }

  state.outbox = enqueueReturn(state.outbox, parsed.data, Date.now(), { createdBy: author });
  await store.replaceOutbox(state.outbox);

  const remaining = Number(live.quantity_on_hand) - Number(quantity);
  const left = Number.isFinite(remaining) ? Math.max(0, remaining).toFixed(3) : live.quantity_on_hand;
  state.holdings = state.holdings.map((h) => (h.lot_id === live.lot_id ? { ...h, quantity_on_hand: left } : h));
  state.obligations = state.obligations.map((o) =>
    o.lot_id === live.lot_id ? { ...o, quantity_on_hand: left } : o,
  );

  state.returning = null;
  formDraft = null;
  state.message = {
    kind: "good",
    text: `Saved on this device: ${quantity} of ${live.lot_number} going back to ${nameOfWarehouse(warehouse)}. The ERP is told when this syncs.`,
  };
  render();
  void drain({ manual: false });
}

/**
 * Open the policy form on the LIVE values, not on the cached ones.
 *
 * The read happens before the form exists, deliberately. Refreshing after it was open would
 * re-render it, and `restoreFormDraft` would put the pre-filled stale values straight back
 * over the fresh ones — the draft cannot tell a value the rep typed from one the renderer
 * supplied. So the order is: read, then render the form, then let the rep type.
 *
 * It matters because the officer is deciding from what the screen says. A device showing
 * thirty days while a colleague moved it to seven an hour ago would have them reason about a
 * rule that is no longer in force. The record itself is safe either way — the server applies
 * the value it is given and stamps the real previous one — but the decision would not be.
 */
async function openPolicyForm(): Promise<void> {
  state.message = null;
  // STRICTLY BEFORE the form exists. Opening it optimistically and refreshing behind it was
  // the first version of this function and it is wrong in a way the rest of this app has a
  // name for: the refresh re-renders, and an officer who started typing in the beat before
  // it landed would have had their input discarded — the exact defect `formDraft` exists to
  // prevent, reintroduced by the thing meant to make the form accurate. The cost is a beat
  // where the button has been pressed and nothing has appeared; the button is only enabled
  // with a network, so it is a beat and not a wait.
  await refreshReference();
  formDraft = null;
  state.editingPolicy = true;
  render();
}

/**
 * Change the tenant's disposal SOP parameters.
 *
 * SENT, NOT QUEUED, and the reasoning is on `putDisposalPolicy`: this is a decision about a
 * tenant-wide rule taken at a desk, not a record of something that happened in a car park. A
 * queued one would take effect whenever a phone next found signal and would overwrite a
 * colleague's in the meantime.
 *
 * THE DEVICE SENDS ONLY WHAT MOVED. Both inputs are pre-filled with what is in force, so
 * submitting the form unchanged would otherwise restate both values — and the server, quite
 * rightly, refuses a change that changes nothing. Comparing against the policy on screen
 * means the rep gets "nothing has changed" from their own device instead of a 409.
 */
async function savePolicy(form: HTMLFormElement): Promise<void> {
  const current = state.policy;
  if (transport === null || store === null || current === null) return;

  const data = new FormData(form);
  const graceRaw = String(data.get("graceDays") ?? "").trim();
  const promo = String(data.get("autoWriteoffPromo") ?? "") === "yes";
  const reason = String(data.get("reason") ?? "").trim();

  // Parsed here rather than left to the server, because `Number("")` is 0 and a blank box
  // must not read as same-day disposal.
  if (!/^\d{1,3}$/.test(graceRaw)) {
    state.message = { kind: "error", text: "The grace period is a whole number of days, between 0 and 365." };
    render();
    return;
  }
  const graceDays = Number(graceRaw);

  const body: Record<string, unknown> = { reason };
  if (graceDays !== current.grace_days) body["graceDays"] = graceDays;
  if (promo !== current.auto_writeoff_promo) body["autoWriteoffPromo"] = promo;
  if (body["graceDays"] === undefined && body["autoWriteoffPromo"] === undefined) {
    state.message = { kind: "warn", text: "Nothing has changed, so there is nothing to record." };
    render();
    return;
  }

  const parsed = PolicyBody.safeParse(body);
  if (!parsed.success) {
    state.message = {
      kind: "error",
      text:
        reason.length < 10
          ? "Say why, in a sentence: this is the authority a regulated deadline is set under, and the record cannot be edited afterwards."
          : `This change cannot be saved: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
    render();
    return;
  }

  const result = await transport.putDisposalPolicy(parsed.data);
  if (result.kind !== "ok") {
    state.message = {
      kind: result.kind === "network" ? "warn" : "error",
      text:
        result.kind === "network"
          ? "No network, so the change was not made. It is not saved on this device either — a policy that took effect whenever a phone found signal would be worse than one that waited."
          : `The server said: ${result.detail ?? result.status}`,
    };
    render();
    return;
  }

  state.editingPolicy = false;
  formDraft = null;
  state.message = { kind: "good", text: "Recorded, with your name and the reason. It applies to stock the sweep finds from now on." };
  render();
  // Re-read rather than patch the state from the reply: the provenance and the history come
  // from the server, and a device that assembled them locally would be inventing the one
  // thing this record exists to be.
  await refreshReference();
}

/**
 * Ask the server to try a dead ERP write again.
 *
 * Direct rather than queued, which is the one deliberate inconsistency in this client and
 * is argued where the transport method lives: this is an operator action on a queue that
 * lives on the server, not a record of something that happened in the field.
 */
async function retryErpWrite(id: string): Promise<void> {
  if (transport === null) return;
  const result = await transport.retryErpWrite(id);
  if (result.kind === "ok") {
    // Dropped from the list immediately: it is queued now, and the next refresh is what
    // confirms whether it got through. Leaving it listed as failed would invite a second
    // press that answers "no longer dead".
    state.failedErpWrites = state.failedErpWrites.filter((w) => w.id !== id);
    state.message = { kind: "good", text: "Queued again. If it fails once more it comes back to this list with the reason." };
  } else {
    state.message = {
      kind: result.kind === "network" ? "warn" : "error",
      text:
        result.kind === "network"
          ? "No network, so the server could not be asked. Try again when there is one."
          : `The server said: ${result.detail ?? result.status}`,
    };
  }
  render();
}

async function currentPosition(): Promise<{ latitude: number; longitude: number; accuracyM?: number } | null> {
  if (!("geolocation" in navigator)) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          ...(Number.isFinite(p.coords.accuracy) ? { accuracyM: p.coords.accuracy } : {}),
        }),
      // A refused or unavailable fix is not an error worth blocking a visit over: the
      // visit matters, the coordinates are an extra.
      () => resolve(null),
      { timeout: 8000, maximumAge: 60_000 },
    );
  });
}

async function drain(opts: { manual: boolean; revive?: boolean }): Promise<void> {
  if (store === null || transport === null || state.blocked !== null || state.syncing) return;
  if (!state.online && !opts.manual) return;

  let author = authorId();
  if (author === null && state.online && state.session !== null && state.phase === "ready") {
    // A session signed in with no network has never reached `/v1/me`, so this device does
    // not know whose rows it is holding. The moment it CAN ask, it must — otherwise the
    // queue stays unsendable until somebody notices the Refresh button, which is how a
    // rep's day sits on a device for a week. Asked here rather than in the `online`
    // handler so that every path into a drain gets it: the browser's event, the Sync
    // button, and coming back to a backgrounded tab.
    await refreshReference();
    author = authorId();
  }
  if (author === null) {
    // Nothing can be sent without knowing whose rows these are, and nothing should be: a
    // row sent under the wrong rep is a record naming somebody who did not do it.
    if (opts.manual) {
      state.message = { kind: "warn", text: "This device does not know who is signed in yet, so it will not send anything under the wrong name." };
      render();
    }
    return;
  }

  // Which CUSTODY movements are in flight, named before they can leave the queue. Any of
  // them settling changes a balance the screen is showing from its own arithmetic.
  const CUSTODY_KINDS = new Set([
    "disbursement",
    "transfer",
    "acceptance",
    "recall",
    // A commit is the one that moves a balance for a count; the lines and the document
    // itself write nothing. A CANCEL is here too, because the optimistic figures a count
    // wrote on this screen are a claim that abandoning it withdraws.
    "count_commit",
    "count_cancel",
    // A write-off changes a balance AND may be what clears a disposal obligation, so the
    // refresh re-reads both lists.
    "write_off",
    // A return does both of those AND is the only one whose landing leaves something for
    // the ERP to accept, which the same refresh reads.
    "return_to_warehouse",
  ]);
  const custodyIdsBefore = state.outbox.filter((e) => CUSTODY_KINDS.has(e.kind)).map((e) => e.id);

  state.syncing = true;
  render();
  let report: SyncReport;
  try {
    report = await syncOnce({
      store,
      transport,
      now: () => Date.now(),
      // A person asking, or the browser saying the network is back, is information the
      // backoff does not have. Without this, Sync now does nothing for up to half an
      // hour after one failure — which the live run caught doing exactly that.
      revive: opts.revive === true || opts.manual,
      repProfileId: author,
    });
  } finally {
    state.syncing = false;
  }
  state.outbox = await store.readOutbox();

  if (report.stopped !== null) {
    state.blocked = report.stopped.reason;
  } else if (report.reauthenticate) {
    // The token is gone or expired. The queue is untouched and the rep signs in again;
    // nothing is lost and nothing is retried against an expired session.
    clearSession();
    state.session = null;
    state.phase = "login";
    state.message = { kind: "warn", text: "Your session expired. Sign in again — nothing on this device has been lost." };
  } else if (report.accepted.length > 0 || report.rejected.length > 0) {
    const bits: string[] = [];
    if (report.accepted.length > 0) bits.push(`${report.accepted.length} sent`);
    if (report.rejected.length > 0) bits.push(`${report.rejected.length} refused`);
    if (report.retrying.length > 0) bits.push(`${report.retrying.length} will retry`);
    state.message = { kind: report.rejected.length > 0 ? "warn" : "good", text: bits.join(", ") };
  }

  // A drain that settled a custody movement makes the local balances stale — an accepted
  // one confirms the optimistic arithmetic, and a REFUSED one means the stock never moved
  // and the screen is now wrong in the other direction. The server is the authority on
  // both, so one read puts it right rather than leaving a number nobody can trust. It also
  // re-reads the two transfer lists, which is how an acceptance or a recall disappears
  // from the screen that offered it.
  //
  // The ids are collected BEFORE the drain, because an accepted row is gone from the
  // queue afterwards and its kind with it. The first version of this asked the queue
  // after the fact and so refreshed after every accepted visit too.
  const settled = new Set([...report.accepted, ...report.rejected.map((r) => r.id)]);
  if (
    custodyIdsBefore.some((id) => settled.has(id)) &&
    state.online &&
    state.blocked === null &&
    state.phase === "ready"
  ) {
    await refreshReference();
  }

  if (report.accepted.length === 0 && report.rejected.length === 0 && opts.manual) {
    state.message = report.retrying.length > 0
      ? { kind: "warn", text: `Could not reach the server; ${report.retrying.length} record(s) still waiting.` }
      : { kind: "good", text: "Nothing to send." };
  }
  render();
}

async function refreshReference(): Promise<void> {
  if (transport === null || store === null) return;
  const meResult = await transport.get("/v1/me");
  if (meResult.kind === "status" && meResult.status === 401) {
    clearSession();
    state.session = null;
    state.phase = "login";
    state.message = { kind: "warn", text: "Your session expired. Sign in again." };
    render();
    return;
  }
  if (meResult.kind !== "ok") {
    state.message = {
      kind: meResult.kind === "network" ? "warn" : "error",
      text: meResult.kind === "network" ? "No network — showing what this device has." : `The server said: ${meResult.detail ?? meResult.status}`,
    };
    if (meResult.kind === "status" && meResult.problemKind === "tenant_deleted") {
      state.blocked = meResult.detail ?? "this tenant has been deleted in the ERP";
    }
    render();
    return;
  }

  const me = Me.safeParse(meResult.body);
  const accountsResult = await transport.get("/v1/accounts");
  const holdingsResult = await transport.get("/v1/samples/holdings");

  // A REQUEST THAT FAILED IS NOT A CONTRACT MISMATCH, and conflating them was a real
  // defect: these are three requests, so a rep who loses signal between the first and the
  // second was told "the server's reply did not match the contract this app was built
  // against" — which sends somebody hunting a version mismatch that does not exist, when
  // the truth is that the network went away mid-refresh. Found by a gate assertion that
  // kept being overwritten by this message at random.
  const unreachable = [accountsResult, holdingsResult].find((r) => r.kind !== "ok");
  if (unreachable !== undefined) {
    state.message =
      unreachable.kind === "network"
        ? { kind: "warn", text: "The network went away part-way through — showing what this device has." }
        : { kind: "error", text: `The server said: ${unreachable.detail ?? String(unreachable.status)}` };
    render();
    return;
  }

  const accounts = accountsResult.kind === "ok" ? AccountList.safeParse(accountsResult.body) : null;
  const holdings = holdingsResult.kind === "ok" ? HoldingList.safeParse(holdingsResult.body) : null;
  if (!me.success || accounts === null || !accounts.success || holdings === null || !holdings.success) {
    // Now this message means what it says: the server answered, and what it answered is
    // not the shape this build was written against.
    state.message = { kind: "error", text: "The server's reply did not match the contract this app was built against." };
    render();
    return;
  }

  // The transfer lists are fetched after the three above and treated as OPTIONAL: a server
  // older than these routes answers 404, and a device that refused to show a rep their
  // accounts and stock because of that would be broken by a feature it does not need.
  // Unreadable means "keep what the cache had" rather than "the list is empty", because an
  // empty list is a claim — "nothing is waiting for you" — and this code has no grounds
  // for it.
  const incomingResult = await transport.get("/v1/samples/transfers/incoming");
  const incoming = incomingResult.kind === "ok" ? IncomingTransferList.safeParse(incomingResult.body) : null;
  const recallableResult = await transport.get("/v1/samples/transfers/recallable");
  const recallable = recallableResult.kind === "ok" ? RecallableTransferList.safeParse(recallableResult.body) : null;
  const peersResult = await transport.get("/v1/samples/transfer-peers");
  const peers = peersResult.kind === "ok" ? TransferPeerList.safeParse(peersResult.body) : null;
  // The counts matter for one reason: an OPEN one refuses every count afterwards
  // (`uq_sample_count_one_open`), so a rep whose last count was left open needs to see it
  // rather than meet it as a conflict.
  const countsResult = await transport.get("/v1/samples/counts");
  const counts = countsResult.kind === "ok" ? CountList.safeParse(countsResult.body) : null;
  const obligationsResult = await transport.get("/v1/samples/obligations");
  const obligations = obligationsResult.kind === "ok" ? ObligationList.safeParse(obligationsResult.body) : null;
  // What the ERP never heard about. Read on every refresh rather than only after a return,
  // because a mirror can die days later — the relay retries on its own schedule and gives
  // up on its own schedule, neither of which this device knows about.
  const failedResult = await transport.get("/v1/erp-writes/failed");
  const failed = failedResult.kind === "ok" ? FailedErpWriteList.safeParse(failedResult.body) : null;
  // The depots. Fetched every refresh and kept on failure like the rest — an empty list is
  // the claim "there is nowhere to send stock back to", and losing the list would quietly
  // turn every return on this device back into a write-off.
  const warehousesResult = await transport.get("/v1/samples/warehouses");
  const warehouses = warehousesResult.kind === "ok" ? WarehouseList.safeParse(warehousesResult.body) : null;
  // The rule every rep is measured against, its history, and whether this rep is one of the
  // two people in the tenant who may change it. `GET /v1/me/roles` has existed since 0023
  // with "so a client can decide which admin screens to show" in its own comment and no
  // consumer; this is the consumer.
  const policyResult = await transport.get("/v1/samples/disposal-policy");
  const policy = policyResult.kind === "ok" ? DisposalPolicy.safeParse(policyResult.body) : null;
  const policyChangesResult = await transport.get("/v1/samples/disposal-policy/history?limit=5");
  const policyChanges =
    policyChangesResult.kind === "ok" ? PolicyChangeList.safeParse(policyChangesResult.body) : null;
  const rolesResult = await transport.get("/v1/me/roles");
  const roles = rolesResult.kind === "ok" ? MyRoles.safeParse(rolesResult.body) : null;
  /**
   * The tenant's configuration history (0061) — fetched only for an administrator.
   *
   * CONDITIONAL, unlike every read above it, and on the roles this same refresh just
   * learned rather than on the ones in state: `GET /v1/admin/config-changes` is
   * administrator-only, so asking unconditionally would mean every rep's device taking a
   * 403 on every refresh. A read that is expected to fail is a read that trains whoever
   * watches the logs to ignore them.
   *
   * It is also the only reference read here that is NOT cached, deliberately. The policy
   * above is cached because a deadline is the point and does not move while a rep is
   * offline; this is an audit trail an administrator reads at a desk, with a network, and
   * writing a tenant's configuration history to a SHARED device's IndexedDB would leave it
   * there for whoever signs in next — the hazard the role reset below exists to close.
   */
  const mayAdminister = roles !== null && roles.success && roles.data.roles.includes("administrator");
  const configResult = mayAdminister ? await transport.get("/v1/admin/config-changes?limit=5") : null;
  const configChanges =
    configResult !== null && configResult.kind === "ok"
      ? ConfigChangeList.safeParse(configResult.body)
      : null;

  state.me = me.data;
  // Stamp the session with the rep it turned out to be, so a later cold start can tell
  // whether the cache on this device belongs to whoever is signed in now.
  if (state.session !== null && state.session.repProfileId !== me.data.repProfileId) {
    state.session = { ...state.session, repProfileId: me.data.repProfileId };
    writeSession(state.session);
  }
  state.accounts = accounts.data.data;
  state.holdings = holdings.data.data;
  if (incoming !== null && incoming.success) state.incoming = incoming.data.data;
  if (recallable !== null && recallable.success) state.recallable = recallable.data.data;
  if (peers !== null && peers.success) state.peers = peers.data.data;
  if (counts !== null && counts.success) state.counts = counts.data.data;
  if (obligations !== null && obligations.success) state.obligations = obligations.data.data;
  if (failed !== null && failed.success) state.failedErpWrites = failed.data.data;
  if (warehouses !== null && warehouses.success) state.warehouses = warehouses.data.data;
  if (policy !== null && policy.success) state.policy = policy.data;
  if (policyChanges !== null && policyChanges.success) state.policyChanges = policyChanges.data.data;
  // Assigned from the ANSWER, and emptied when there was no answer to have: a rep who lost
  // the administrator grant this morning must not keep last night's history on screen.
  state.configChanges = configChanges !== null && configChanges.success ? configChanges.data.data : [];
  // Assigned even when the list is EMPTY, unlike the reads above: an empty set of roles is a
  // real answer and the one that must stick, or a rep who lost their grant this morning
  // would keep a form the server now refuses.
  if (roles !== null && roles.success) state.roles = roles.data.roles;
  state.cachedAt = Date.now();
  const cache: CachedReference = {
    me: me.data,
    accounts: accounts.data.data,
    visits: [],
    holdings: holdings.data.data,
    incoming: state.incoming,
    recallable: state.recallable,
    peers: state.peers,
    counts: state.counts,
    obligations: state.obligations,
    failedErpWrites: state.failedErpWrites,
    warehouses: state.warehouses,
    ...(state.policy !== null ? { policy: state.policy } : {}),
    policyChanges: state.policyChanges,
    roles: state.roles,
    fetchedAt: state.cachedAt,
  };
  await store.writeCache(cache);
  render();
}

function adoptSession(session: Session): void {
  // A new session is a new person until the server says otherwise. Whatever reference
  // data is on screen belongs to whoever was signed in before, so it goes now rather
  // than lingering until `/v1/me` answers — which, offline, is never.
  if (state.me !== null && state.me.repProfileId !== session.repProfileId) {
    state.me = null;
    state.accounts = [];
    state.holdings = [];
    state.incoming = [];
    state.recallable = [];
    state.peers = [];
    state.counts = [];
    state.obligations = [];
    state.failedErpWrites = [];
    state.warehouses = [];
    // The policy is the tenant's and would be the same for the next rep — the ROLES are not,
    // and a form left on screen for somebody who does not hold the grant is the whole shape
    // of mistake the shared-device work exists to stop. Both go, because a policy with no
    // provenance on screen beside somebody else's name is no better.
    state.policy = null;
    state.policyChanges = [];
    state.configChanges = [];
    state.roles = [];
    state.editingPolicy = false;
    state.cachedAt = null;
  }
  writeSession(session);
  state.session = session;
  state.phase = "ready";
  state.message = null;
  render();
  void refreshReference().then(() => drain({ manual: false }));
}

// ---- boot -----------------------------------------------------------------

async function boot(): Promise<void> {
  render();

  try {
    state.config = await loadConfig();
  } catch (err) {
    state.phase = "fatal";
    state.message = { kind: "error", text: `Configuration could not be loaded: ${(err as Error).message}` };
    render();
    return;
  }

  try {
    store = indexedDbStore(await openDatabase());
  } catch (err) {
    // Fatal, and said so. An app that runs without its local database would accept a
    // visit and lose it on the next navigation, which is worse than refusing to start.
    state.phase = "fatal";
    state.message = { kind: "error", text: (err as Error).message };
    render();
    return;
  }

  state.outbox = await store.readOutbox();
  if (state.outbox.some((e) => e.state === "blocked")) {
    state.blocked = state.outbox.find((e) => e.state === "blocked")?.lastReason ?? "syncing has been stopped";
  }
  const cached = await store.readCache();
  // WHOSE CACHE IS IT. A device is shared, and the cache holds one rep's identity, their
  // accounts, their stock and the transfers addressed to them. Adopting it for whoever
  // signs in next is wrong in two directions at once: it shows one rep another rep's
  // round, and `authorId()` would stamp anything recorded with the wrong
  // `repProfileId` — the exact misattribution the queue's author field exists to stop,
  // arriving through the cache instead of the queue. So it is adopted only when the
  // stored session says it was fetched for this session's rep, and a session that has
  // never reached `/v1/me` has no claim on it at all.
  const sessionOnDisk = readSession();
  const cacheIsOurs =
    cached !== null &&
    sessionOnDisk !== null &&
    sessionOnDisk.repProfileId !== undefined &&
    sessionOnDisk.repProfileId === cached.me.repProfileId;
  if (cached !== null && cacheIsOurs) {
    state.me = cached.me;
    state.accounts = cached.accounts;
    // `?? []` rather than a required field: a cache written before holdings existed is
    // still a usable cache, and refusing it would lose a rep's accounts on an upgrade.
    state.holdings = cached.holdings ?? [];
    state.incoming = cached.incoming ?? [];
    state.recallable = cached.recallable ?? [];
    state.peers = cached.peers ?? [];
    state.counts = cached.counts ?? [];
    state.obligations = cached.obligations ?? [];
    state.failedErpWrites = cached.failedErpWrites ?? [];
    state.warehouses = cached.warehouses ?? [];
    state.policy = cached.policy ?? null;
    state.policyChanges = cached.policyChanges ?? [];
    state.roles = cached.roles ?? [];
    state.cachedAt = cached.fetchedAt;
  }

  const config = state.config;
  transport = new ApiTransport({
    baseUrl: config.apiBaseUrl,
    accessToken: () => state.session?.accessToken ?? null,
    tenantId: () => state.session?.tenantId ?? null,
  });

  // A callback from the identity provider, before anything else decides we are logged out.
  const callback = readCallback(location.search);
  if (callback.code !== undefined || callback.error !== undefined) {
    try {
      const session = await completeLogin(
        {
          issuer: config.oidc.issuer,
          clientId: config.oidc.clientId,
          redirectUri: new URL("./", location.href).toString(),
          scope: config.oidc.scope,
          ...(config.oidc.audience !== undefined ? { audience: config.oidc.audience } : {}),
        },
        callback,
        { storage: sessionStorageAuth() },
      );
      history.replaceState(null, "", new URL("./", location.href).toString());
      adoptSession(session);
      return;
    } catch (err) {
      state.phase = "login";
      state.message = { kind: "error", text: (err as Error).message };
      render();
      return;
    }
  }

  const existing = readSession();
  if (existing !== null && !isExpired(existing, Date.now())) {
    state.session = existing;
    state.phase = "ready";
    render();
    void refreshReference().then(() => drain({ manual: false }));
  } else {
    if (existing !== null) clearSession();
    state.phase = "login";
    render();
  }

  window.addEventListener("online", () => {
    state.online = true;
    render();
    void drain({ manual: false, revive: true });
  });
  window.addEventListener("offline", () => {
    state.online = false;
    render();
  });
  // A rep locks the phone mid-round and comes back in signal. Nothing else would notice.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void drain({ manual: false });
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // No service worker means no offline shell, which is worth knowing but not worth
      // blocking on: the outbox is IndexedDB and works either way.
      state.message = { kind: "warn", text: "This browser would not install the offline shell." };
      render();
    });
  }
}

void boot();
