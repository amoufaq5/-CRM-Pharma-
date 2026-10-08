import { z } from "zod";

import type { Session } from "./auth.js";

/**
 * Where the access token lives: `localStorage`, deliberately and with its cost stated.
 *
 * The alternatives are worse for this app. In memory only means a rep re-authenticates
 * every time the OS kills the tab, which on a phone is constantly — and an app that asks
 * for a login in a car park with no signal is an app that cannot record the visit. A
 * cookie needs the API to issue it, which it does not: it verifies a bearer JWT and holds
 * no session state.
 *
 * So the exposure is accepted and bounded: tokens are short-lived (the API's own expiry,
 * minus a minute), nothing here is a refresh token unless the issuer gave us one, and
 * an attacker who can run script in this origin can read the token — which is true of
 * every storage a browser offers. What it buys is the offline case working at all.
 */
const KEY = "crm.field.session";

const Stored = z.object({
  accessToken: z.string(),
  expiresAt: z.number(),
  refreshToken: z.string().optional(),
  tenantId: z.string().optional(),
  subject: z.string().optional(),
  repProfileId: z.string().optional(),
});

export function readSession(storage: Pick<Storage, "getItem"> = localStorage): Session | null {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return null;
    const parsed = Stored.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Blocked storage, or a half-written value from a killed tab. Treated as "no
    // session" rather than crashing the boot.
    return null;
  }
}

export function writeSession(session: Session, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* a private window still gets to use the app for this tab's lifetime */
  }
}

export function clearSession(storage: Pick<Storage, "removeItem"> = localStorage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    /* nothing to undo */
  }
}
