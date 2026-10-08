import {
  AcceptBody,
  Account,
  AccountList,
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
  enqueueAcceptance,
  enqueueDisbursement,
  enqueueRecall,
  enqueueSignature,
  enqueueTransfer,
  enqueueVisit,
  heldForOthers,
  mintUuidV7,
  summariseOutbox,
  syncOnce,
  type CachedReference,
  type ClientStore,
  type IncomingTransfer,
  type OutboxEntry,
  type RecallableTransfer,
  type SyncReport,
  type TransferPeer,
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
  cachedAt: number | null;
  outbox: readonly OutboxEntry[];
  online: boolean;
  /** The account a visit is being recorded against, if the form is open. */
  recording: Account | null;
  /** The lot being disbursed, if that form is open. */
  disbursing: Holding | null;
  /** The lot being transferred to a colleague, if that form is open. */
  transferring: Holding | null;
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
  cachedAt: null,
  outbox: [],
  online: navigator.onLine,
  recording: null,
  disbursing: null,
  transferring: null,
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
  }
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
  } else {
    parts.push(renderAccounts(now));
    parts.push(renderHoldings(now));
    parts.push(renderTransfers(now));
  }

  root.innerHTML = parts.join("");
  wireReady();
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
          <button class="secondary" data-transfer="${escapeHtml(h.lot_id)}" ${Number(h.quantity_on_hand) <= 0 ? "disabled" : ""}>Transfer</button></li>`;
        })
        .join("")}
    </ul>
  </section>`;
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
    render();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-visit]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["visit"];
      state.recording = state.accounts.find((a) => a.erp_account_id === id) ?? null;
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

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-transfer]")) {
    button.addEventListener("click", () => {
      const lotId = button.dataset["transfer"];
      state.transferring = state.holdings.find((h) => h.lot_id === lotId) ?? null;
      state.message = null;
      render();
    });
  }
  on("cancel-transfer", "click", () => {
    state.transferring = null;
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
        state.outbox = state.outbox.filter((e) => e.id !== id && e.dependsOn !== id);
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

  state.outbox = state.outbox.filter((e) => e.id !== entryId && e.dependsOn !== entryId);
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
  const custodyIdsBefore = state.outbox
    .filter((e) => e.kind === "disbursement" || e.kind === "transfer" || e.kind === "acceptance" || e.kind === "recall")
    .map((e) => e.id);

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
  const accounts = accountsResult.kind === "ok" ? AccountList.safeParse(accountsResult.body) : null;
  const holdingsResult = await transport.get("/v1/samples/holdings");
  const holdings = holdingsResult.kind === "ok" ? HoldingList.safeParse(holdingsResult.body) : null;
  if (!me.success || accounts === null || !accounts.success || holdings === null || !holdings.success) {
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
  state.cachedAt = Date.now();
  const cache: CachedReference = {
    me: me.data,
    accounts: accounts.data.data,
    visits: [],
    holdings: holdings.data.data,
    incoming: state.incoming,
    recallable: state.recallable,
    peers: state.peers,
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
