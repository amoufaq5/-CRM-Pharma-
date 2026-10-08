// A browser, driven over the DevTools Protocol, with no dependencies.
//
// WHY NOT PLAYWRIGHT. The alternative is one devDependency, a browser download pinned to
// its version, and an install step in CI. What this harness actually needs is five verbs
// — navigate, evaluate, go offline, come back, screenshot — and Node 22 ships a
// WebSocket client, so those five are a hundred lines. It is the same reasoning that gave
// this repo a hand-rolled SMTP sink and a hand-rolled JWKS server rather than a test
// framework for each: the harness should be readable by whoever is debugging what it
// caught.
//
// `Network.emulateNetworkConditions {offline: true}` is the one capability nothing else
// provides, and it is the whole reason this file exists: an offline-first client that has
// never been offline is a guess.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env["CHROME_PATH"],
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

export function findChrome() {
  // A glob over the playwright cache too, so a different revision in CI still resolves.
  const fromCache = (() => {
    const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
    if (root === undefined || !existsSync(root)) return null;
    try {
      for (const entry of readdirSync(root)) {
        const candidate = join(root, entry, "chrome-linux", "chrome");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* fall through to the fixed list */
    }
    return null;
  })();

  for (const path of [...CANDIDATES, fromCache]) {
    if (path !== undefined && path !== null && existsSync(path)) return path;
  }
  throw new Error(
    "no Chrome or Chromium found. Set CHROME_PATH, or install one — this check drives a real browser on purpose.",
  );
}

export async function launchBrowser({ headless = true } = {}) {
  const binary = findChrome();
  const profile = mkdtempSync(join(tmpdir(), "crm-field-profile-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    // Sandboxing needs user namespaces this container does not grant; the page under
    // test is our own bundle on loopback, so the trade is sound here and nowhere else.
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`the browser never printed a DevTools URL:\n${buffer}`)), 30_000);
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser exited with ${code} before listening:\n${buffer}`));
    });
  });

  const connection = await connect(wsUrl);
  return {
    binary,
    async close() {
      try {
        await connection.send("Browser.close", {});
      } catch {
        /* closing a browser that already went is not a failure */
      }
      connection.socket.close();
      child.kill("SIGKILL");
      // The profile directory is still being written as the process dies, so a plain
      // rmdir races it and throws ENOTEMPTY — which would fail a run whose checks all
      // passed. Retries, and a failure to tidy up is not a failure of the check.
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* a leftover temp profile is not worth failing a verification over */
      }
    },
    connection,
  };
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  const send = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });

  return { socket, send, onMessage: (fn) => listeners.push(fn) };
}

/** One tab, with the page events this harness needs already enabled. */
export async function newPage(browser) {
  const { connection } = browser;
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });

  const consoleLines = [];
  const pageErrors = [];
  connection.onMessage((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      consoleLines.push(`${message.params.type}: ${text}`);
    }
    if (message.method === "Runtime.exceptionThrown") {
      // Surfaced rather than swallowed: a page that threw during boot otherwise shows up
      // as "the selector was not found", which sends the reader to the wrong place.
      const d = message.params.exceptionDetails;
      pageErrors.push(d.exception?.description ?? d.text ?? "unknown page error");
    }
  });

  const send = (method, params) => connection.send(method, params, sessionId);
  await send("Page.enable", {});
  await send("Runtime.enable", {});
  await send("Network.enable", {});

  const page = {
    consoleLines,
    pageErrors,
    send,

    async goto(url) {
      const loaded = new Promise((resolve) => {
        const off = connection.onMessage((message) => {
          if (message.sessionId === sessionId && message.method === "Page.loadEventFired") resolve(off);
        });
      });
      await send("Page.navigate", { url });
      await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error(`${url} never finished loading`)), 30_000))]);
    },

    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(
          `the page threw while evaluating: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    },

    async offline(isOffline) {
      await send("Network.emulateNetworkConditions", {
        offline: isOffline,
        latency: 0,
        downloadThroughput: isOffline ? 0 : -1,
        uploadThroughput: isOffline ? 0 : -1,
      });
      // The app listens for the browser's own online/offline events, which CDP's network
      // emulation does not fire. Dispatching them is how a real device's transition is
      // reproduced rather than approximated.
      await page.evaluate(`window.dispatchEvent(new Event(${isOffline ? '"offline"' : '"online"'})); return true;`);
    },

    async waitFor(expression, { timeoutMs = 10_000, label = expression } = {}) {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeoutMs) {
        last = await page.evaluate(`return (${expression});`);
        if (last === true) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
    },

    async textOf(selector) {
      return page.evaluate(`return document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null;`);
    },

    async click(selector) {
      const clicked = await page.evaluate(
        `const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.click(); return true;`,
      );
      if (clicked !== true) throw new Error(`nothing to click at ${selector}`);
    },

    async fill(selector, value) {
      const filled = await page.evaluate(
        `const el = document.querySelector(${JSON.stringify(selector)});
         if (el === null) return false;
         el.value = ${JSON.stringify(value)};
         el.dispatchEvent(new Event("input", { bubbles: true }));
         return true;`,
      );
      if (filled !== true) throw new Error(`nothing to fill at ${selector}`);
    },

    /**
     * Draw on the page with REAL input events.
     *
     * `Input.dispatchMouseEvent` is synthesized by the browser into the same pointer
     * events a finger produces, so the signature pad's own `pointerdown`/`pointermove`
     * handlers run. Calling the handlers directly would test the test: the thing worth
     * knowing is whether a stroke drawn on glass becomes bytes.
     */
    async draw(selector, points) {
      // SCROLLED INTO VIEW FIRST, and this is not a convenience: `Input.dispatchMouseEvent`
      // takes VIEWPORT coordinates, and the signature pad sits below a header, an outbox
      // summary and a form. Off-screen, the events landed on whatever happened to be at
      // those coordinates and the canvas stayed blank — which read as "pointer events do
      // not reach it" and sent me looking in the wrong place. A rep scrolls to it too.
      const box = await page.evaluate(
        `const el = document.querySelector(${JSON.stringify(selector)});
         if (el === null) return null;
         el.scrollIntoView({ block: "center", inline: "center" });
         await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
         const r = el.getBoundingClientRect();
         return { x: r.left, y: r.top, width: r.width, height: r.height };`,
      );
      if (box === null) throw new Error(`nothing to draw on at ${selector}`);
      if (box.y < 0 || box.y + box.height > (await page.evaluate("return window.innerHeight;"))) {
        throw new Error(`${selector} is not fully in the viewport after scrolling; input events would miss it`);
      }

      const at = (p) => ({ x: Math.round(box.x + p[0] * box.width), y: Math.round(box.y + p[1] * box.height) });
      const first = at(points[0]);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...first });
      for (const point of points.slice(1)) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...at(point) });
      }
      const last = at(points[points.length - 1]);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...last });
    },

    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(data, "base64"));
    },
  };
  return page;
}
