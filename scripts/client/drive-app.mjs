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
      await new Promise((res, rej) => {
        const tx = db.transaction("outbox", "readwrite");
        tx.objectStore("outbox").put({
          id,
          kind: "visit",
          body: { id, erpAccountId: "acc-not-mine", status: "completed" },
          state: "pending", attempts: 0, nextAttemptAt: 0, queuedAt: Date.now(),
        });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;`);
    is(refused, true, "a visit for an account outside the rep's territory is queued");
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

    // ---- 11. the ERP deletes the tenant, and the queue STOPS ---------------
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
