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
    const refusalText = await page.evaluate(`return document.querySelector("section:has(> h2) .meta.error")?.textContent?.trim() ?? document.body.textContent;`);
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
