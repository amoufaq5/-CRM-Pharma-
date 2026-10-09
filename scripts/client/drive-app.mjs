// Drives the field app in a real browser, against the real API, and checks Postgres.
//
// ADR-0001's open table has carried one row longer than any other: THERE IS NO CLIENT.
// Everything the CRM built for an offline device — ids minted before the network exists,
// `POST /v1/sync/visits` with per-row outcomes, upsert-by-device-id for idempotent
// replay — was a guess about a consumer that did not exist. This is the script that stops
// it being a guess.
//
// The shape is the repo's: the shell owns the processes, this file owns the assertions,
// and every check is `ok:`/`FAIL:` with a count at the end. What makes it worth the
// machinery is the one thing no unit test can do — the browser is actually taken offline,
// mid-session, with a visit half-recorded.
//
// Usage: node drive-app.mjs <app-url> <work-dir>
//   env: CRM_FIELD_TOKEN, CRM_FIELD_TENANT, CRM_PGDATABASE, PGHOST/PGUSER/PGPASSWORD
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchBrowser, newPage } from "./cdp.mjs";

const appUrl = process.argv[2];
const work = process.argv[3] ?? ".";
const token = process.env["CRM_FIELD_TOKEN"];
const token2 = process.env["CRM_FIELD_TOKEN_2"];
const tenant = process.env["CRM_FIELD_TENANT"];
const database = process.env["CRM_PGDATABASE"];
const lotId = process.env["CRM_FIELD_LOT_ID"];

let checks = 0;
let failures = 0;
const ok = (message) => {
  checks += 1;
  console.log(`ok: ${message}`);
};
const fail = (message) => {
  checks += 1;
  failures += 1;
  console.log(`FAIL: ${message}`);
};
const is = (actual, expected, message) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? ok(message)
    : fail(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** psql as the ADMIN, deliberately: the harness checks what the app wrote, from outside
 *  the app's own tenant context, so an assertion cannot be satisfied by RLS hiding a row. */
function sql(query) {
  return execFileSync("psql", ["-d", database, "-At", "-F", "|", "-c", query], {
    encoding: "utf8",
    env: { ...process.env, PGDATABASE: database },
  }).trim();
}

function visitRows() {
  const out = sql(
    `SELECT id, erp_account_id, status, outcome, duration_minutes, COALESCE(notes,'') FROM crm.visit WHERE tenant_id = '${tenant}' ORDER BY recorded_at, id`,
  );
  return out === "" ? [] : out.split("\n").map((line) => {
    const [id, account, status, outcome, minutes, notes] = line.split("|");
    return { id, account, status, outcome, minutes, notes };
  });
}

function disbursementRows() {
  const out = sql(
    `SELECT id, lot_id, quantity, recipient_name, signature_sha256 FROM crm.sample_transaction
      WHERE tenant_id = '${tenant}' AND kind = 'disbursement' ORDER BY recorded_at, id`,
  );
  return out === "" ? [] : out.split("\n").map((line) => {
    const [id, lot, quantity, recipient, sha] = line.split("|");
    return { id, lot, quantity, recipient, sha };
  });
}

/**
 * The device's own queue, read out of IndexedDB inside the page.
 *
 * A snippet rather than a function because `evaluate` ships an expression to the browser:
 * there is no shared scope between this file and the page, so the helper has to travel
 * with each call.
 */
const READ_OUTBOX = `
  const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
  const rows = await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });`;

/**
 * The transfer side of the ledger, joined to the names a transfer is about.
 *
 * Joined here rather than asserted on ids because the ids are minted by the device and
 * the assertion that matters is about PEOPLE: this quantity, from this rep, to that one.
 */
function transferRows(kind = "transfer_out") {
  const out = sql(
    `SELECT t.id, t.quantity, COALESCE(t.transfer_of::text, ''), r.subject, COALESCE(c.subject, ''), COALESCE(c.display_name, '')
       FROM crm.sample_transaction t
       JOIN crm.rep_profile r ON r.id = t.rep_profile_id
       LEFT JOIN crm.rep_profile c ON c.id = t.counterparty_rep_profile_id
      WHERE t.tenant_id = '${tenant}' AND t.kind = '${kind}' ORDER BY t.recorded_at, t.id`,
  );
  return out === "" ? [] : out.split("\n").map((line) => {
    const [id, quantity, transfer_of, rep, counterparty, counterparty_name] = line.split("|");
    return { id, quantity, transfer_of, rep, counterparty, counterparty_name };
  });
}

function countRows() {
  const out = sql(
    `SELECT id, status, COALESCE(note,''), counted_at FROM crm.sample_count
      WHERE tenant_id = '${tenant}' ORDER BY created_at`,
  );
  return out === "" ? [] : out.split("\n").map((line) => {
    const [id, status, note, countedAt] = line.split("|");
    return { id, status, note, countedAt };
  });
}

/** A count's lines with BOTH variances — the server's and the one the counter could see. */
function countLineRows() {
  const out = sql(
    `SELECT cl.counted_quantity, cl.expected_quantity,
            COALESCE(cl.device_expected_quantity::text,''),
            (cl.counted_quantity - cl.expected_quantity)::text,
            COALESCE((cl.counted_quantity - cl.device_expected_quantity)::text,'')
       FROM crm.sample_count_line cl WHERE cl.tenant_id = '${tenant}' ORDER BY cl.created_at`,
  );
  return out === "" ? [] : out.split("\n").map((line) => {
    const [counted, expected, deviceExpected, variance, deviceVariance] = line.split("|");
    return { counted, expected, deviceExpected, variance, deviceVariance };
  });
}

function adjustmentRows() {
  const out = sql(
    `SELECT kind, quantity, COALESCE(count_id::text,''), COALESCE(reason,'')
       FROM crm.sample_transaction
      WHERE tenant_id = '${tenant}' AND kind IN ('adjustment_in','adjustment_out')
      ORDER BY recorded_at`,
  );
  return out === "" ? [] : out.split("\n").map((line) => {
    const [kind, quantity, count_id, reason] = line.split("|");
    return { kind, quantity, count_id, reason };
  });
}

/** One rep's balance for the lot under test, as `on_hand|in_transit`, or "" if they hold no row. */
function holding(subject) {
  return sql(
    `SELECT h.quantity_on_hand || '|' || h.quantity_in_transit
       FROM crm.sample_holding h JOIN crm.rep_profile r ON r.id = h.rep_profile_id
      WHERE h.tenant_id = '${tenant}' AND h.lot_id = '${lotId}' AND r.subject = '${subject}'`,
  );
}

function signatureRows() {
  const out = sql(
    `SELECT id, subject_id, content_sha256, byte_size, content_type FROM crm.attachment
      WHERE tenant_id = '${tenant}' AND purpose = 'disbursement_signature' ORDER BY uploaded_at, id`,
  );
  return out === "" ? [] : out.split("\n").map((line) => {
    const [id, subject, sha, size, type] = line.split("|");
    return { id, subject, sha, size: Number(size), type };
  });
}

async function main() {
  if (token === undefined || tenant === undefined || database === undefined || appUrl === undefined) {
    throw new Error("drive-app.mjs needs <app-url>, CRM_FIELD_TOKEN, CRM_FIELD_TENANT and CRM_PGDATABASE");
  }
  if (token2 === undefined) {
    throw new Error("drive-app.mjs needs CRM_FIELD_TOKEN_2 — the transfer chapter needs a second rep");
  }

  const browser = await launchBrowser();
  const page = await newPage(browser);
  const shot = (name) => page.screenshot(join(work, `app-${name}.png`));

  try {
    // ---- 1. the app loads and asks for a login ---------------------------
    await page.goto(appUrl);
    await page.waitFor(`document.querySelector("#app")?.getAttribute("aria-busy") === "false"`, { label: "the app to boot" });
    is(await page.textOf("header.bar h1"), "Field", "the app boots and renders its own shell");
    const hasLogin = await page.evaluate(`return document.querySelector("#dev-token") !== null;`);
    is(hasLogin, true, "an unauthenticated device is offered a sign-in, not a blank screen");
    await shot("1-login");

    // ---- 2. a session, and the rep's own accounts -------------------------
    await page.fill("#dev-token", token);
    await page.fill("#dev-tenant", tenant);
    await page.click("#dev-login");
    await page.waitFor(`document.querySelectorAll("button[data-visit]").length > 0`, { label: "the account list" });
    const accounts = await page.evaluate(
      `return [...document.querySelectorAll("button[data-visit]")].map((b) => b.dataset.visit);`,
    );
    // The API orders by `s.name NULLS LAST`, so Riverside comes before St Mary's. The
    // screen showing the server's order rather than an id order is the correct coupling,
    // and this assertion was wrong first.
    is(accounts, ["acc-live-2", "acc-live-1"], "the API's /v1/accounts reaches the screen, in the rep's own territory and the server's order");
    const whose = await page.textOf("header.bar .who");
    is(whose, "Ada Lovelace", "/v1/me names the signed-in rep");
    await shot("2-accounts");

    // ---- 3. OFFLINE, and a visit recorded anyway -------------------------
    await page.offline(true);
    is(await page.textOf("header.bar .pill"), "offline", "the app says it is offline");

    await page.click(`button[data-visit="acc-live-1"]`);
    await page.waitFor(`document.querySelector("#visit-form") !== null`, { label: "the visit form" });
    await page.fill(`select[name="visitType"]`, "detailing");
    await page.fill(`select[name="outcome"]`, "successful");
    await page.fill(`input[name="durationMinutes"]`, "25");
    await page.fill(`textarea[name="notes"]`, "Offline in a lift. Discussed dosing.");
    await page.click("#save-visit");
    await page.waitFor(`/Saved on this device/.test(document.body.textContent ?? "")`, { label: "the save confirmation" });
    ok("a visit is recorded with no network, and the screen says it is on the device — not filed");
    await shot("3-offline-saved");

    const queuedWhileOffline = await page.evaluate(`
      const db = await new Promise((res, rej) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const rows = await new Promise((res, rej) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
      return rows.map((r) => ({ id: r.id, state: r.state, account: r.body.erpAccountId, minutes: r.body.durationMinutes }));`);
    is(queuedWhileOffline.length, 1, "the visit is in IndexedDB, which is what survives the tab being killed");
    is(queuedWhileOffline[0]?.state, "pending", "and it is pending, not sent");
    const deviceId = queuedWhileOffline[0]?.id;
    is(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deviceId ?? ""), true,
      `the id was minted on the device as a v7 UUID (${deviceId})`);
    is(visitRows().length, 0, "and NOTHING is in crm.visit yet — the queue is the only copy");

    // ---- 4. a sync attempt while still offline changes nothing ------------
    await page.click("#sync");
    await page.waitFor(`/still waiting|Could not reach/.test(document.body.textContent ?? "")`, { label: "the offline sync message" });
    ok("syncing while offline reports it could not reach the server, and keeps the row");
    is(visitRows().length, 0, "still nothing in the database");

    // ---- 5. back online: the row lands, once ------------------------------
    await page.offline(false);
    await page.waitFor(`document.querySelector("header.bar .pill")?.textContent === "online"`, { label: "the online pill" });
    await page.waitFor(`/1 sent/.test(document.body.textContent ?? "")`, { timeoutMs: 15_000, label: "the sent confirmation" });
    await shot("5-synced");

    const landed = visitRows();
    is(landed.length, 1, "exactly one row in crm.visit");
    is(landed[0]?.id, deviceId, "and its primary key is the id the DEVICE minted, which is what makes a replay idempotent");
    is(landed[0]?.account, "acc-live-1", "against the account the rep chose");
    is(landed[0]?.status, "completed", "with the status the form sent");
    is(landed[0]?.minutes, "25", "and the duration");
    is(landed[0]?.notes, "Offline in a lift. Discussed dosing.", "and the notes");

    const drained = await page.evaluate(`
      const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
      return await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").count(); t.onsuccess = () => res(t.result); });`);
    is(drained, 0, "the outbox is empty, so nothing will be sent twice");

    // ---- 6. a replay cannot duplicate ------------------------------------
    // The property the whole design rests on, tested the only way that means anything:
    // send the same body again, through the same API, and count the rows.
    const replay = await page.evaluate(`
      const r = await fetch("/v1/sync/visits", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + ${JSON.stringify(token)}, "x-tenant-id": ${JSON.stringify(tenant)} },
        body: JSON.stringify({ visits: [{ id: ${JSON.stringify(deviceId)}, erpAccountId: "acc-live-1", status: "completed", durationMinutes: 25 }] }),
      });
      return { status: r.status, body: await r.json() };`);
    is(replay.status, 200, "re-sending an already-accepted visit is accepted again");
    is(visitRows().length, 1, "and there is STILL one row — the upsert by device id holds");

    // ---- 7. three visits offline, one batch -------------------------------
    await page.offline(true);
    for (const [account, note] of [["acc-live-1", "second"], ["acc-live-2", "third"], ["acc-live-2", "fourth"]]) {
      await page.click(`button[data-visit="${account}"]`);
      await page.waitFor(`document.querySelector("#visit-form") !== null`);
      await page.fill(`textarea[name="notes"]`, note);
      await page.click("#save-visit");
      await page.waitFor(`document.querySelector("#visit-form") === null`);
    }
    const threeQueued = await page.evaluate(`
      const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
      return await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").count(); t.onsuccess = () => res(t.result); });`);
    is(threeQueued, 3, "three visits queue up across a round with no signal");
    is(visitRows().length, 1, "none of them reaches the database while offline");

    await page.offline(false);
    await page.waitFor(`/3 sent/.test(document.body.textContent ?? "")`, { timeoutMs: 15_000, label: "three sent" });
    is(visitRows().length, 4, "and all three land in one batch when the signal returns");
    await shot("7-batch");

    // ---- 8. a refusal the rep can read -----------------------------------
    // An account outside the rep's territory: the API answers `outside_territory`, which
    // the classifier calls permanent. The row must stay, visible, with the server's own
    // sentence — not vanish, and not loop.
    const refused = await page.evaluate(`
      const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
      // ONE id for both the key and the body. The first version of this fixture minted
      // two, and the row became immortal — never matched, never reported. That bug is now
      // refused by rejectUnreconcilable in @crm/client, and this fixture is simply correct.
      const id = crypto.randomUUID().replace(/-4(?=[0-9a-f]{3}-)/, "-7");
      // AND the rep who recorded it, read out of the device's own reference cache. A row
      // without one is held rather than sent — which is the point of the field, and which
      // this fixture discovered by being written without it: the visit was never sent at
      // all, so the refusal it exists to test never arrived.
      const cached = await new Promise((res) => {
        const t = db.transaction("cache", "readonly").objectStore("cache").get("reference");
        t.onsuccess = () => res(t.result);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction("outbox", "readwrite");
        tx.objectStore("outbox").put({
          id,
          kind: "visit",
          body: { id, erpAccountId: "acc-not-mine", status: "completed" },
          state: "pending", attempts: 0, nextAttemptAt: 0, queuedAt: Date.now(),
          createdBy: cached?.me?.repProfileId,
        });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return cached?.me?.repProfileId !== undefined;`);
    is(refused, true, "a visit for an account outside the rep's territory is queued, attributed to this rep");
    await page.goto(appUrl);
    await page.waitFor(`document.querySelector("#sync") !== null`, { label: "the app to reload with the queue" });
    await page.click("#sync");
    await page.waitFor(`/Refused by the server/.test(document.body.textContent ?? "")`, { timeoutMs: 15_000, label: "the refusal section" });
    // Scoped to the refusal section. Falling back to document.body.textContent — which
    // the first version did — would pass if the word appeared anywhere at all, including
    // in a heading this test wrote itself.
    const refusalText = await page.evaluate(`
      const heading = [...document.querySelectorAll("h2")].find((h) => /Refused by the server/.test(h.textContent ?? ""));
      if (heading === undefined) return null;
      return heading.closest("section")?.querySelector(".meta.error")?.textContent?.trim() ?? null;`);
    is(refusalText !== null, true, "the refusal is rendered inside the Refused-by-the-server section");
    is(/territor/i.test(String(refusalText)), true, `the server's own words are on screen (${String(refusalText).slice(0, 80)})`);
    is(visitRows().length, 4, "and the refused visit did not reach the database");
    const stillQueued = await page.evaluate(`
      const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
      const rows = await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });
      return rows.map((r) => r.state);`);
    is(stillQueued, ["rejected"], "the refused row is KEPT as rejected, not dropped — a visit that happened is not deleted by a 403");
    await shot("8-refused");

    // ---- 9. the offline shell --------------------------------------------
    // A rep opens the app in a car park with no signal. Without a service worker this is
    // the browser's offline page and the queue is unreachable.
    await page.offline(true);
    await page.goto(appUrl);
    await page.waitFor(`document.querySelector("header.bar h1") !== null`, { timeoutMs: 15_000, label: "the shell to load from cache while offline" });
    is(await page.textOf("header.bar h1"), "Field", "the app opens with NO network, served by its own service worker");
    const offlineAccounts = await page.evaluate(`return document.querySelectorAll("button[data-visit]").length;`);
    is(offlineAccounts, 2, "and the cached account list is there, so a visit can still be recorded");
    const staleness = await page.evaluate(`return /Cached .* ago/.test(document.body.textContent ?? "");`);
    is(staleness, true, "with how old it is stated, rather than implied to be live");
    await shot("9-offline-cold-start");
    await page.offline(false);

    // ---- 10. samples: a disbursement and its signature, offline --------------
    // The act at the centre of a pharma visit, and the one with legal weight. BEFORE the
    // deletion step below, necessarily: 0050's `erp_deleted` is terminal and 0053 made it
    // unreachable in reverse, so nothing after it can sync anything. Two queued
    // rows in a fixed order: the ledger commits to a digest of the signature, and the
    // image goes up afterwards to a route that 404s until that row exists.
    await page.goto(appUrl);
    await page.waitFor(`document.querySelectorAll("button[data-disburse]").length > 0`, { label: "the holdings list" });
    const lots = await page.evaluate(
      `return [...document.querySelectorAll("li")]
         .filter((li) => li.querySelector("button[data-disburse]") !== null)
         .map((li) => li.querySelector(".meta")?.textContent?.trim() ?? "");`,
    );
    is(lots.length, 1, "the rep's own stock reaches the screen from /v1/samples/holdings");
    is(/10\.000 on hand/.test(String(lots[0])), true, `with the balance the ledger's trigger computed (${String(lots[0]).slice(0, 60)})`);

    await page.offline(true);
    await page.click(`button[data-disburse="${lotId}"]`);
    await page.waitFor(`document.querySelector("#disburse-form") !== null`, { label: "the disburse form" });

    // Refused before anything is queued: the ledger row commits to a signature, so there
    // is no such thing as a disbursement without one.
    await page.fill(`input[name="quantity"]`, "2");
    await page.fill(`input[name="recipientName"]`, "Dr Ada Lovelace");
    await page.click("#save-disbursement");
    await page.waitFor(`/A signature is required/.test(document.body.textContent ?? "")`, { label: "the missing-signature refusal" });
    ok("a disbursement with no signature is refused at the keyboard, not queued");
    is(disbursementRows().length, 0, "and nothing was written");

    // A real stroke, with real input events, on a real canvas.
    await page.draw("#signature-pad", [[0.15, 0.7], [0.3, 0.3], [0.45, 0.75], [0.6, 0.25], [0.8, 0.6]]);
    const drawn = await page.evaluate(`
      const canvas = document.querySelector("#signature-pad");
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) { if (data[i] < 200) ink += 1; }
      return ink;`);
    is(drawn > 100, true, `a stroke drawn with pointer events leaves ink on the canvas (${drawn} dark pixels)`);
    await shot("11-signature-drawn");

    // THE RE-RENDER THAT USED TO ERASE IT. This app re-renders from state on every
    // online/offline transition, and each render replaces the DOM — including the canvas,
    // and the strokes on it. A rep in a clinic regaining signal mid-signature would have
    // watched their signature vanish with no message. Firing the event here is the only
    // way to know it survives.
    await page.evaluate(`window.dispatchEvent(new Event("online")); return true;`);
    await page.waitFor(`document.querySelector("#signature-pad") !== null`, { label: "the form to survive the render" });
    // The settle matters as much as the event: `online` renders, then drains, and the
    // drain renders AGAIN. The first implementation of the restore survived one render
    // and lost the strokes on the second, because it redrew from a data URL
    // asynchronously and the second render snapshotted the still-blank canvas.
    const survived = await page.evaluate(`
      await new Promise((r) => setTimeout(r, 400));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const canvas = document.querySelector("#signature-pad");
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) { if (data[i] < 200) ink += 1; }
      return ink;`);
    is(survived > 100, true, `the signature survives a re-render triggered by regaining signal (${survived} dark pixels)`);
    await page.offline(true);

    await page.fill(`input[name="quantity"]`, "2");
    await page.fill(`input[name="recipientName"]`, "Dr Ada Lovelace");
    await page.click("#save-disbursement");
    await page.waitFor(`/the disbursement, then its signature/.test(document.body.textContent ?? "")`, { label: "the saved confirmation" });
    ok("with a signature it is saved on the device, and the screen says both halves are queued");

    const queuedPair = await page.evaluate(`
      const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
      const rows = await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });
      return rows.map((r) => ({ kind: r.kind, state: r.state, dependsOn: r.dependsOn ?? null, sha: r.body.signatureSha256 ?? null, bytes: (r.body.contentBase64 ?? "").length }));`);
    const pair = queuedPair.filter((r) => r.kind === "disbursement" || r.kind === "signature");
    is(pair.length, 2, "two rows are queued for one disbursement, not one");
    const queuedDisbursement = pair.find((r) => r.kind === "disbursement");
    const queuedSignature = pair.find((r) => r.kind === "signature");
    is(queuedDisbursement?.sha?.length, 64, "the disbursement carries the digest of a signature that has not been uploaded yet");
    is(queuedSignature?.dependsOn !== null, true, "and the signature knows which disbursement it belongs to");
    is(queuedSignature?.bytes > 100, true, `with the PNG itself on the device (${queuedSignature?.bytes} base64 chars)`);
    is(disbursementRows().length, 0, "and the database has neither");

    // The holding on screen is spent, so a second disbursement cannot be offered stock
    // the first has already used.
    const afterLocal = await page.evaluate(`return document.querySelector("li:has(button[data-disburse]) .meta")?.textContent?.trim() ?? "";`);
    is(/8\.000 on hand/.test(String(afterLocal)), true, `the lot's balance falls on the device while offline (${String(afterLocal).slice(0, 40)})`);

    await page.offline(false);
    await page.waitFor(`/2 sent/.test(document.body.textContent ?? "")`, { timeoutMs: 20_000, label: "both halves sent" });
    await shot("11-samples-synced");

    const ledger = disbursementRows();
    is(ledger.length, 1, "one disbursement in crm.sample_transaction");
    is(ledger[0]?.quantity, "2.000", "for the quantity the form sent, as a decimal the column can hold");
    is(ledger[0]?.recipient, "Dr Ada Lovelace", "naming who signed for it");
    is(ledger[0]?.lot, lotId, "against the lot the rep chose");

    const signatures = signatureRows();
    is(signatures.length, 1, "and one signature attachment");
    is(signatures[0]?.subject, ledger[0]?.id, "attached to that disbursement");
    is(signatures[0]?.type, "image/png", "as a PNG");
    is(signatures[0]?.size > 100, true, `with real bytes behind it (${signatures[0]?.size} bytes)`);
    // THE COMMITMENT. The ledger row was written before the image existed anywhere but a
    // canvas; the blob trigger recomputed this digest from the stored bytes.
    is(signatures[0]?.sha, ledger[0]?.sha, "and its stored bytes hash to exactly what the ledger committed to");

    // ---- 11. transfers: two reps, two devices ------------------------------
    // The first thing in this app that takes two people. One device signed in as one rep
    // cannot prove a transfer: the sender's half and the receiver's half are different
    // routes, scoped to different reps, and the material is in neither rep's hands in
    // between — it is in `quantity_in_transit`, which is the column this whole chapter is
    // really about.
    await page.offline(true);
    await page.click("button[data-transfer]");
    await page.waitFor(`document.querySelector("#transfer-form") !== null`, { label: "the transfer form" });

    const peerOptions = await page.evaluate(`
      return [...document.querySelectorAll("#transfer-form select[name=toRepProfileId] option")].map((o) => o.textContent.trim());`);
    is(peerOptions.length, 1, `the picker offers one colleague (${JSON.stringify(peerOptions)})`);
    is(/Grace Hopper/.test(String(peerOptions[0])), true, "which is the active one, by name and employee number");
    // The two it must NOT offer: the departed rep, who would be a destination nobody
    // should be given, and the rep themselves, which the database refuses outright.
    is(/Departed/.test(peerOptions.join(" ")), false, "and never the departed rep");
    is(/Ada/.test(peerOptions.join(" ")), false, "and never the sender");
    await shot("12-transfer-form");

    // A transfer of more than the rep holds is refused at the keyboard, not hours later as
    // a 409 from inside a queue.
    await page.fill(`#transfer-form input[name="quantity"]`, "99");
    await page.click("#save-transfer");
    await page.waitFor(`/cannot be sent/.test(document.body.textContent ?? "")`, { label: "the over-balance refusal" });
    is(await page.evaluate(`${READ_OUTBOX} return rows.filter((r) => r.kind === "transfer").length;`), 0,
      "a transfer of more than the rep is carrying is refused at the keyboard, and queues nothing");

    // And the form is still there, with the refusal above it. A rep who mistyped a
    // quantity must not be sent back to the list to start again.
    is(await page.evaluate(`return document.querySelector("#transfer-form") !== null;`), true,
      "and the form survives the refusal, so the rep can correct the quantity rather than start again");

    // Queued, then CANCELLED — which is not a recall. The server has never heard of this
    // transfer, so discarding the row leaves no ledger movement at all, where a recall
    // would write two for material that never moved.
    await page.fill(`#transfer-form input[name="quantity"]`, "2");
    await page.click("#save-transfer");
    await page.waitFor(`document.querySelector("button[data-unsend]") !== null`, { label: "the unsent transfer" });
    const afterQueued = await page.textOf("li:has(button[data-disburse]) .meta");
    is(/6\.000 on hand/.test(String(afterQueued)), true, `the quantity leaves the balance as soon as it is queued (${String(afterQueued).slice(0, 48)})`);
    is(/2\.000 in transit/.test(String(afterQueued)), true, "and appears in transit, which is where the ledger will put it");
    await page.click("button[data-unsend]");
    await page.waitFor(`/never sent/.test(document.body.textContent ?? "")`, { label: "the cancellation" });
    const afterCancel = await page.textOf("li:has(button[data-disburse]) .meta");
    is(/8\.000 on hand/.test(String(afterCancel)), true, "cancelling an unsent transfer puts it straight back on the balance");
    is(await page.evaluate(`${READ_OUTBOX} return rows.filter((r) => r.kind === "transfer").length;`), 0,
      "and leaves nothing queued to send");
    is(transferRows().length, 0, "nothing reached the ledger, because nothing ever left");

    // Now the real one: 3 units to Grace, recorded with no network.
    await page.click("button[data-transfer]");
    await page.waitFor(`document.querySelector("#transfer-form") !== null`, { label: "the transfer form once more" });
    await page.fill(`#transfer-form input[name="quantity"]`, "3");
    await page.click("#save-transfer");
    await page.waitFor(`document.querySelector("button[data-unsend]") !== null`, { label: "the queued transfer" });
    const queuedTransfer = await page.evaluate(
      `${READ_OUTBOX} const t = rows.find((r) => r.kind === "transfer"); return t === undefined ? null : { state: t.state, createdBy: t.createdBy ?? null };`,
    );
    is(queuedTransfer?.state, "pending", "the transfer is queued on the device, pending");
    is(typeof queuedTransfer?.createdBy, "string", "and names the rep who recorded it, which is what stops another sign-in sending it");
    is(transferRows().length, 0, "and the database still has nothing");

    await page.offline(false);
    await page.waitFor(`/1 sent/.test(document.body.textContent ?? "")`, { timeoutMs: 20_000, label: "the transfer to land" });
    const sent = transferRows();
    is(sent.length, 1, "one transfer_out in crm.sample_transaction");
    is(sent[0]?.quantity, "3.000", "for the quantity the form sent");
    is(sent[0]?.counterparty_name, "Grace Hopper", "addressed to the colleague the rep picked");
    is(holding("rep-ada"), "5.000|3.000", "the sender's balance moved from on-hand into IN TRANSIT, by the ledger's trigger");
    is(holding("rep-grace"), "", "and the receiver holds nothing yet, because nobody has accepted it");
    await shot("13-transfer-sent");

    // ---- 12. the other rep's device ----------------------------------------
    // A second browser with its own profile: its own IndexedDB and its own localStorage.
    // A second tab would have shared both and proved nothing about two devices.
    const graceBrowser = await launchBrowser();
    const grace = await newPage(graceBrowser);
    try {
      await grace.goto(appUrl);
      await grace.waitFor(`document.querySelector("#app")?.getAttribute("aria-busy") === "false"`, { label: "Grace's app to boot" });
      await grace.fill("#dev-token", token2);
      await grace.fill("#dev-tenant", tenant);
      await grace.click("#dev-login");
      await grace.waitFor(`document.querySelector("button[data-accept]") !== null`, { timeoutMs: 20_000, label: "the incoming transfer" });

      const offered = await grace.textOf("li:has(button[data-accept]) .name");
      is(offered, "3.000 × LOT-FIELD-1 from Ada Lovelace", "the receiver is shown what it is and who sent it, not a pair of ids");
      const offeredMeta = await grace.textOf("li:has(button[data-accept]) .meta");
      is(/itm-live-1/.test(String(offeredMeta)) && /expires 20/.test(String(offeredMeta)), true,
        `with the item and the expiry a rep needs before taking custody (${String(offeredMeta).slice(0, 60)})`);
      // The mirror property, on a real screen: the SENDER is never offered an accept, and
      // the receiver is never offered a recall.
      is(await grace.evaluate(`return document.querySelector("button[data-recall]") !== null;`), false,
        "and no recall button, because only the sender may take it back");
      is(await page.evaluate(`return document.querySelector("button[data-accept]") !== null;`), false,
        "while the sender is offered no accept, because only the receiver may take it");
      await grace.screenshot(join(work, "app-14-incoming.png"));

      // Accepted with no network, like everything else in this app.
      await grace.offline(true);
      await grace.click("button[data-accept]");
      await grace.waitFor(`/accepting 3/.test(document.body.textContent ?? "")`, { label: "the queued acceptance" });
      const queuedAcceptance = await grace.evaluate(`
        const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
        const rows = await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });
        return rows.map((r) => ({ kind: r.kind, transferOf: r.transferOf ?? null, dependsOn: r.dependsOn ?? null }));`);
      is(queuedAcceptance.length, 1, "one row is queued on the receiver's device");
      is(queuedAcceptance[0]?.kind, "acceptance", "an acceptance");
      is(queuedAcceptance[0]?.transferOf, sent[0]?.id, "naming the transfer it settles");
      // THE DISTINCTION THAT MATTERS: it carries the transfer's id without depending on it.
      // The transfer was recorded on Ada's device and is already on the server, so a
      // dependency would be a wait for a row this queue will never hold.
      is(queuedAcceptance[0]?.dependsOn, null, "and NOT waiting for it, because it is already on the server");
      is(transferRows("transfer_in").length, 0, "and the database has no acceptance yet");

      await grace.offline(false);
      await grace.waitFor(`/1 sent/.test(document.body.textContent ?? "")`, { timeoutMs: 20_000, label: "the acceptance to land" });
      const accepted = transferRows("transfer_in");
      is(accepted.length, 1, "one transfer_in in crm.sample_transaction");
      is(accepted[0]?.quantity, "3.000", "for the quantity the SENDER declared, which the receiver cannot alter");
      is(accepted[0]?.transfer_of, sent[0]?.id, "linked to the transfer it accepts, which is what makes it a pair");
      is(holding("rep-grace"), "3.000|0.000", "the receiver now holds the material");
      is(holding("rep-ada"), "5.000|0.000", "and the sender's in-transit is clear — the total across both reps never changed");
      await grace.waitFor(`document.querySelector("button[data-accept]") === null`, { timeoutMs: 20_000, label: "the incoming list to empty" });
      ok("the transfer leaves the receiver's screen once it is accepted");
      await grace.screenshot(join(work, "app-15-accepted.png"));

      // ---- 13. a shared device, and a queue that is not yours --------------
      // Grace records a transfer back to Ada and does not send it. Then ADA signs in on
      // this same device — which is what happens when a phone is shared, or a rep hands
      // their tablet to a colleague. Every write route attributes the record to the
      // caller in the token, so draining Grace's row under Ada's session would file
      // Grace's sample movement under Ada's name, and nothing downstream could tell.
      await grace.offline(true);
      await grace.click("button[data-transfer]");
      await grace.waitFor(`document.querySelector("#transfer-form") !== null`, { label: "Grace's transfer form" });
      await grace.fill(`#transfer-form input[name="quantity"]`, "1");
      await grace.click("#save-transfer");
      await grace.waitFor(`document.querySelector("button[data-unsend]") !== null`, { label: "Grace's unsent transfer" });

      await grace.evaluate(`localStorage.removeItem("crm.field.session"); return true;`);
      await grace.goto(appUrl);
      await grace.waitFor(`document.querySelector("#dev-token") !== null`, { label: "the sign-in after the session was cleared" });
      await grace.fill("#dev-token", token);
      await grace.fill("#dev-tenant", tenant);
      await grace.click("#dev-login");

      // STILL OFFLINE, so `/v1/me` has never answered for this session. The device does
      // not know who is in front of it — and the cached identity belongs to the previous
      // rep, so adopting it would have put her name on screen and, worse, stamped
      // anything Ada recorded with Grace's `repProfileId`. Found by this very step: the
      // first version of it waited for the held notice and timed out, because the app had
      // quietly carried on as Grace.
      await grace.waitFor(`/Waiting to know who is signed in/.test(document.body.textContent ?? "")`, { timeoutMs: 20_000, label: "the unknown-identity notice" });
      ok("a new sign-in with no network does not inherit the previous rep's identity from the cache");
      is(await grace.textOf("header.bar .who"), null, "and shows nobody's name rather than the wrong person's");
      is(await grace.evaluate(`return document.querySelector("button[data-transfer]") !== null;`), false,
        "and offers no stock to move, because the stock on this device is not known to be this rep's");
      await grace.screenshot(join(work, "app-16-unknown.png"));

      await grace.offline(false);
      await grace.waitFor(`/Held for another sign-in/.test(document.body.textContent ?? "")`, { timeoutMs: 20_000, label: "the held notice" });
      ok("and once it can ask, it says plainly that it is holding somebody else's record");
      await grace.click("#sync");
      await grace.waitFor(`/will not send|Nothing to send|sent/.test(document.body.textContent ?? "")`, { timeoutMs: 20_000, label: "the sync verdict" });
      // The proof is in the database, not on the screen: Grace's transfer is still the
      // only one she never sent, and no transfer_out exists from her.
      is(transferRows().filter((r) => r.rep === "rep-grace").length, 0,
        "and pressing Sync as the other rep sends nothing of hers — the row is held, not filed under the wrong name");
      const stillQueued = await grace.evaluate(`
        const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
        const rows = await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });
        return rows.map((r) => ({ kind: r.kind, state: r.state, attempts: r.attempts }));`);
      is(stillQueued.length, 1, "her record is still on the device");
      is(stillQueued[0]?.state, "pending", "pending, not refused — there is nothing wrong with it");
      is(stillQueued[0]?.attempts, 0, "and it has not been tried, so its backoff is untouched for when she signs back in");
      await grace.screenshot(join(work, "app-17-held.png"));
    } finally {
      await graceBrowser.close();
    }

    // ---- 14. the sender takes material back --------------------------------
    // A recall is a new ledger movement, never an edit: the material went out and came
    // back, and both halves stay in the log. Before it existed, a transfer nobody accepted
    // left the quantity in `quantity_in_transit` with no way out.
    await page.click("#refresh");
    await page.waitFor(`document.querySelector("button[data-transfer]") !== null`, { timeoutMs: 20_000, label: "Ada's screen to refresh" });
    await page.click("button[data-transfer]");
    await page.waitFor(`document.querySelector("#transfer-form") !== null`, { label: "the transfer form for the recall case" });
    await page.fill(`#transfer-form input[name="quantity"]`, "1");
    await page.click("#save-transfer");
    await page.waitFor(`document.querySelector("button[data-recall]") !== null`, { timeoutMs: 20_000, label: "the sent transfer, now recallable" });
    ok("a transfer that has LANDED is offered as a recall rather than a cancel, because the server has it now");
    // ONCE THE QUEUE HAS DRAINED, and not before. A transfer can legitimately be both
    // queued and on the server at the same time — a reply lost after the row was written
    // leaves it pending for a retry while the ledger already has it — so asserting this
    // the instant a recall appears is a race, and one run caught it being one. What must
    // be true is the steady state: a transfer the server holds is offered as a recall and
    // not as a cancel, because cancelling would discard this device's copy and leave the
    // server's behind.
    // Until the TRANSFER has left the queue — not until the queue is empty, which it never
    // is: the refused out-of-territory visit from §8 is deliberately still there, kept for
    // a person to look at. An assertion written as "the queue is empty" failed on exactly
    // that, which is the gate telling the truth about a rule the gate had forgotten.
    for (let i = 0; i < 100; i += 1) {
      const gone = await page.evaluate(`${READ_OUTBOX} return rows.every((r) => r.kind !== "transfer");`);
      if (gone === true) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const atRecall = await page.evaluate(
      `${READ_OUTBOX} return { unsend: document.querySelector("button[data-unsend]") !== null, recall: document.querySelector("button[data-recall]") !== null, queue: rows.map((r) => r.kind + ":" + r.state) };`,
    );
    is(atRecall.queue.filter((k) => k.startsWith("transfer")), [],
      "no transfer is left on the device once it has been sent");
    is(atRecall.unsend, false,
      `and it is no longer offered as a cancel (queue: ${JSON.stringify(atRecall.queue)})`);
    is(atRecall.recall, true, "while the recall stays on offer, because the server is the one holding it now");
    const sentAgain = transferRows().filter((r) => r.quantity === "1.000");
    is(sentAgain.length, 1, "the second transfer is in the ledger, which is why it can only be recalled");

    // Decided with no signal, like everything else a rep decides. The recall is queued
    // against a transfer the server already has, so it carries that id and waits for
    // nothing.
    await page.offline(true);
    await page.click("button[data-recall]");
    // An IIFE because `waitFor` takes an EXPRESSION — it wraps what it is given in a
    // `return (…)`, so a multi-statement snippet has to be a call rather than a body.
    await page.waitFor(
      `(async () => { ${READ_OUTBOX} return rows.some((r) => r.kind === "recall"); })()`,
      { label: "the queued recall" },
    );
    const queuedRecall = await page.evaluate(
      `${READ_OUTBOX} const r = rows.find((x) => x.kind === "recall"); return r === undefined ? null : { transferOf: r.transferOf ?? null, dependsOn: r.dependsOn ?? null };`,
    );
    is(queuedRecall?.transferOf, sentAgain[0]?.id, "the queued recall names the transfer it takes back");
    is(queuedRecall?.dependsOn, null, "and waits for nothing, because that transfer has already landed");
    is(transferRows("transfer_recall").length, 0, "with nothing in the ledger while there is no signal");

    await page.offline(false);
    await page.waitFor(`document.querySelector("button[data-recall]") === null`, { timeoutMs: 20_000, label: "the recall to land" });

    const recalls = transferRows("transfer_recall");
    is(recalls.length, 1, "one transfer_recall in crm.sample_transaction");
    is(recalls[0]?.quantity, "1.000", "for the quantity that was in transit, read off the transfer rather than from the client");
    is(holding("rep-ada"), "5.000|0.000", "and the material is back on the sender's balance, out of transit");
    is(holding("rep-grace"), "3.000|0.000", "with the receiver untouched — they never had it");
    await shot("18-recalled");

    // ---- 15. counting the bag, where the bag is -----------------------------
    // A count is the one custody document whose whole purpose is to happen away from a
    // desk, and it is the first thing in this app that is a DOCUMENT rather than a
    // movement: four routes, three of them addressed to an id the device had to mint
    // before there was anywhere to send it.
    await page.offline(true);
    await page.click("#start-count");
    await page.waitFor(`document.querySelector("#count-form") !== null`, { label: "the count form" });

    // THE FIELD IS EMPTY. The expected figure is shown and never pre-filled: a form that
    // arrives holding the answer is one a tired rep taps through, and what that produces is
    // a document saying somebody counted when nobody did.
    const field = await page.evaluate(
      `const i = document.querySelector("#count-form input[name^='count:']"); return { value: i?.value ?? null, shown: i?.closest("li")?.querySelector(".meta")?.textContent?.trim() ?? null };`,
    );
    is(field.value, "", "every count field starts EMPTY, so nothing is confirmed by tapping through");
    is(/device shows 5\.000/.test(String(field.shown)), true, `with the balance shown beside it instead (${String(field.shown).slice(0, 40)})`);
    await shot("19-count-form");

    // A number the ledger cannot hold is refused at the keyboard: inside a queue it is one
    // line's `validation_failed` hours later, which refuses the commit and takes the whole
    // count with it.
    await page.fill(`#count-form input[name="count:${lotId}"]`, "4.00001");
    await page.click("#save-count");
    await page.waitFor(`/not numbers the ledger can hold/.test(document.body.textContent ?? "")`, { label: "the refusal" });
    is(await page.evaluate(`${READ_OUTBOX} return rows.filter((r) => r.kind === "count").length;`), 0,
      "a count with an impossible quantity is refused at the keyboard, and queues nothing");

    // An empty count is not a count of zero.
    await page.fill(`#count-form input[name="count:${lotId}"]`, "");
    await page.click("#save-count");
    await page.waitFor(`/Nothing was counted/.test(document.body.textContent ?? "")`, { label: "the empty-count refusal" });
    is(await page.evaluate(`${READ_OUTBOX} return rows.filter((r) => r.kind === "count_line").length;`), 0,
      "and a count with nothing filled in writes off nothing — a blank field is not a zero");

    // The real count: the rep finds 4 where the device says 5.
    await page.fill(`#count-form input[name="count:${lotId}"]`, "4");
    await page.fill(`#count-form input[name="note"]`, "counted in the car park");
    await page.click("#save-count");
    await page.waitFor(`document.querySelector("button[data-discard-count]") !== null`, { label: "the queued count" });

    const queuedCount = await page.evaluate(
      `${READ_OUTBOX} return rows.filter((r) => r.kind.startsWith("count")).map((r) => ({ kind: r.kind, id: r.id, countOf: r.countOf ?? null, dependsOn: r.dependsOn ?? null, body: r.body }));`,
    );
    is(queuedCount.length, 3, "one count queues THREE rows: the document, a line, and the commit");
    const doc = queuedCount.find((r) => r.kind === "count");
    const line = queuedCount.find((r) => r.kind === "count_line");
    const commit = queuedCount.find((r) => r.kind === "count_commit");
    is(doc?.body?.note, "counted in the car park", "the document carries the note a reviewer reads");
    is(line?.id, `${doc?.id}:${lotId}`, "the line is keyed by (count, lot), the way the server keys its row");
    is(line?.body?.deviceExpectedQuantity, "5.000", "and carries what the DEVICE showed, not only what was counted");
    is(line?.dependsOn, [doc?.id], "the line waits for the document, which the server has never heard of yet");
    // THE DEPENDENCY THAT NEEDED A LIST. A commit that went early would write adjustments
    // for the lots that happened to arrive and leave the rest of the bag unreconciled.
    is(commit?.dependsOn, [doc?.id, line?.id], "and the COMMIT waits for the document AND every line");
    is(countRows().length, 0, "nothing is in crm.sample_count while there is no signal");

    const countedLocally = await page.textOf("li:has(button[data-disburse]) .meta");
    is(/4\.000 on hand/.test(String(countedLocally)), true, `the screen shows what was counted, because that is what the ledger will say (${String(countedLocally).slice(0, 30)})`);
    is(await page.evaluate(`return document.querySelector("#start-count")?.disabled === true;`), true,
      "and a second count cannot be started while this one is unsent — one count is open at a time");

    // SOMETHING MOVES WHILE THE COUNT IS IN THE BAG. A warehouse receipt is confirmed
    // elsewhere — another device, a desk — so by the time the line arrives the server holds
    // 7 where the rep was shown 5 and counted 4. This is the case 0056 exists for.
    const receipt = await fetch(new URL("v1/samples/receipts", appUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": tenant, "content-type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID().replace(/-4(?=[0-9a-f]{3}-)/, "-7"),
        lotId,
        quantity: "2",
        occurredAt: new Date().toISOString(),
        erpWarehouseId: "wh-live-1",
      }),
    });
    is(receipt.status, 201, "a receipt lands from somewhere else while the count sits unsent on the device");

    await page.offline(false);
    await page.waitFor(`document.querySelector("button[data-discard-count]") === null`, { timeoutMs: 25_000, label: "the count to land" });

    const counts = countRows();
    is(counts.length, 1, "one row in crm.sample_count");
    is(counts[0]?.id, doc?.id, "under the id the DEVICE minted, which is what let the line be addressed at all");
    is(counts[0]?.status, "committed", "committed, because the commit went last and after every line");
    is(counts[0]?.note, "counted in the car park", "with the note the rep wrote");

    const lines = countLineRows();
    is(lines.length, 1, "one counted line");
    is(lines[0]?.counted, "4.000", "holding what the rep counted");
    is(lines[0]?.expected, "7.000", "the balance the SERVER held when the line arrived");
    is(lines[0]?.deviceExpected, "5.000", "and the balance the DEVICE had shown them when they counted");
    // The pair is the finding: the rep saw a variance of 1 and the ledger reconciled 3,
    // and the 2 in between is the receipt that landed while the count was in a bag. One
    // column could not have said that, and letting the device overwrite the server's figure
    // would have hidden it.
    is(lines[0]?.variance, "-3.000", "so the reviewer sees the variance against what was held");
    is(lines[0]?.deviceVariance, "-1.000", "AND the variance the counter could actually see");

    const adjustments = adjustmentRows();
    is(adjustments.length, 1, "one adjustment in the ledger, not an edit to a balance");
    is(adjustments[0]?.kind, "adjustment_out", "out, because the bag held less than the books");
    is(adjustments[0]?.quantity, "3.000", "for the difference against what was HELD, so the balance ends at what was counted");
    is(adjustments[0]?.count_id, doc?.id, "linked to the count that found it, structurally rather than in prose");
    is(holding("rep-ada"), "4.000|0.000", "and the balance is exactly what the rep counted");
    ok("the count reconciled a balance it had never seen, which is the whole point of counting offline");
    await shot("20-counted");

    is(await page.evaluate(`return document.querySelector("#start-count")?.disabled === true;`), false,
      "and another count can be started now that this one is settled");

    // ---- 16. the ERP deletes the tenant, and the queue STOPS ---------------
    // The whole chain, end to end, for the first time: the ERP signs a tombstone, 0050's
    // watcher marks the registry row, the API refuses every request for that tenant with
    // `tenant_deleted`, and the client — which is the only part of this that had never
    // existed — stops retrying and says so. `problems.ts` asked for exactly this
    // behaviour in as many words: "an offline client holding a queue of unsent visits
    // needs to stop retrying and say so rather than spin on a refusal it reads as
    // transient permissions."
    await page.offline(true);
    await page.click(`button[data-visit="acc-live-1"]`);
    await page.waitFor(`document.querySelector("#visit-form") !== null`);
    await page.fill(`textarea[name="notes"]`, "recorded just before the tenant was deleted");
    await page.click("#save-visit");
    await page.waitFor(`document.querySelector("#visit-form") === null`);
    const beforeDeletion = visitRows().length;

    // The registry row the ERP's deletion would produce. `tenant_erp_deleted_needs_receipt`
    // makes the status unreachable without a receipt, so the fixture has to carry one —
    // which is the constraint doing its job even here.
    sql(`INSERT INTO crm.tenant (tenant_id, display_name, status, erp_tombstone_id, erp_tombstone_kind,
           erp_tombstone_deleted_at, erp_tombstone_proof_sha256, erp_tombstone_observed_at)
         VALUES ('${tenant}', 'Live tenant', 'erp_deleted', 'tomb_live_tenant_0001', 'tenant_deletion',
                 now(), repeat('a', 64), now())`);
    ok("the ERP's tombstone is recorded against the tenant, which is the only way to reach that status");

    await page.offline(false);
    await page.waitFor(`document.querySelector("header.bar .pill.blocked") !== null`, { timeoutMs: 20_000, label: "the stopped pill" });
    const stopped = await page.evaluate(`
      const heading = [...document.querySelectorAll("h2")].find((h) => /Syncing has stopped/.test(h.textContent ?? ""));
      return heading === undefined ? null : heading.closest("section")?.textContent?.replace(/\\s+/g, " ").trim() ?? null;`);
    is(stopped !== null, true, "the app says syncing has STOPPED, rather than showing a spinner forever");
    is(/deleted/i.test(String(stopped)), true, `and says why, in the server's words (${String(stopped).slice(0, 90)})`);
    is(/will not be sent/.test(String(stopped)), true, "and that the records are held rather than sent");
    is(/Nothing is deleted/.test(String(stopped)), true, "and that nothing on the device has been thrown away");

    const blocked = await page.evaluate(`
      const db = await new Promise((res) => { const r = indexedDB.open("crm-field", 1); r.onsuccess = () => res(r.result); });
      const rows = await new Promise((res) => { const t = db.transaction("outbox", "readonly").objectStore("outbox").getAll(); t.onsuccess = () => res(t.result); });
      return rows.map((r) => r.state).sort();`);
    is(blocked.includes("blocked"), true, "the queue is blocked on the device, not drained and not dropped");
    is(visitRows().length, beforeDeletion, "and no further visit reached the database after the deletion");

    const syncDisabled = await page.evaluate(`return document.querySelector("#sync")?.disabled === true;`);
    is(syncDisabled, true, "Sync now is disabled, so a rep cannot be told to keep trying something that cannot work");
    await shot("10-tenant-deleted");

    if (page.pageErrors.length > 0) {
      fail(`the page threw ${page.pageErrors.length} error(s): ${page.pageErrors.join(" | ")}`);
    } else {
      ok("the page threw no uncaught errors throughout");
    }
  } finally {
    writeFileSync(join(work, "app-console.log"), page.consoleLines.join("\n") + "\n");
    await browser.close();
  }

  console.log(`\n${checks} checks, ${failures} failure(s)`);
  if (failures > 0) process.exit(1);
}

await main();
