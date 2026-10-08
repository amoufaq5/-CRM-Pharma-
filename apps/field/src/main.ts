import {
  Account,
  AccountList,
  Me,
  VisitBody,
  enqueueVisit,
  mintUuidV7,
  summariseOutbox,
  syncOnce,
  type CachedReference,
  type ClientStore,
  type OutboxEntry,
  type SyncReport,
} from "@crm/client";

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
  cachedAt: number | null;
  outbox: readonly OutboxEntry[];
  online: boolean;
  /** The account a visit is being recorded against, if the form is open. */
  recording: Account | null;
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
  cachedAt: null,
  outbox: [],
  online: navigator.onLine,
  recording: null,
  message: null,
  blocked: null,
  syncing: false,
};

let store: ClientStore | null = null;
let transport: ApiTransport | null = null;

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
  parts.push(state.recording !== null ? renderVisitForm(state.recording) : renderAccounts(now));

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

  lines.push(`<section>
    <h2>On this device</h2>
    <ul class="list">
      <li><span class="grow"><span class="name">${summary.pending} visit(s) waiting to send</span>
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
            (e) => `<li><span class="grow"><span class="name">${escapeHtml(e.body.erpAccountId)}</span>
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

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-discard]")) {
    button.addEventListener("click", () => {
      const id = button.dataset["discard"];
      void (async () => {
        if (store === null || id === undefined) return;
        // A discard is a decision, so it removes only that row and only on a click. The
        // app never discards anything on its own.
        state.outbox = state.outbox.filter((e) => e.id !== id);
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

  state.outbox = enqueueVisit(state.outbox, parsed.data, Date.now());
  await store.replaceOutbox(state.outbox);
  state.recording = null;
  state.message = { kind: "good", text: "Saved on this device. It will sync when there is a network." };
  render();
  void drain({ manual: false });
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
  } else if (opts.manual) {
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
  if (!me.success || accounts === null || !accounts.success) {
    state.message = { kind: "error", text: "The server's reply did not match the contract this app was built against." };
    render();
    return;
  }

  state.me = me.data;
  state.accounts = accounts.data.data;
  state.cachedAt = Date.now();
  const cache: CachedReference = { me: me.data, accounts: accounts.data.data, visits: [], fetchedAt: state.cachedAt };
  await store.writeCache(cache);
  render();
}

function adoptSession(session: Session): void {
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
  if (cached !== null) {
    state.me = cached.me;
    state.accounts = cached.accounts;
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
