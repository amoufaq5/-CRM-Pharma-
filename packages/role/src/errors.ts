/** A role name that is not one of ROLES. */
export class UnknownRoleError extends Error {
  constructor(readonly role: string) {
    super(`${JSON.stringify(role)} is not a role; expected one of administrator, compliance`);
    this.name = "UnknownRoleError";
  }
}

/** Four eyes: the grantor and the holder are the same person, or the revoker and the holder are. */
export class SelfGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfGrantError";
  }
}

/** The rep already holds this role over an overlapping period. */
export class RoleAlreadyHeldError extends Error {
  constructor(
    readonly role: string,
    readonly from: string,
  ) {
    super(
      `that rep already holds ${role} over a period covering ${from}. ` +
        `Revoke the existing grant first — a role is held once at a time.`,
    );
    this.name = "RoleAlreadyHeldError";
  }
}

/** Revoking or deactivating would leave the tenant with no administrator. */
export class LastAdministratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastAdministratorError";
  }
}

/** The grant was already ended. Distinct from "no such grant", which is not an error. */
export class GrantAlreadyRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantAlreadyRevokedError";
  }
}

/** A grant may be ended; it may not be edited or deleted. */
export class GrantImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantImmutableError";
  }
}

/**
 * Recognises the database's own refusals so a caller gets a typed error.
 *
 * Matched on constraint name and on the message text the migration raises — the text
 * is the contract here, which is why 0023 raises sentences rather than codes and why
 * these tests assert on them.
 */
export function translateRoleError(err: unknown, context: { role?: string; from?: string } = {}): Error {
  const e = err as { code?: string; constraint?: string; message?: string };
  const msg = e?.message ?? "";

  if (e?.code === "23P01" || e?.constraint === "rep_role_no_overlap") {
    return new RoleAlreadyHeldError(context.role ?? "that role", context.from ?? "the requested date");
  }
  if (e?.constraint === "rep_role_no_self_grant") {
    return new SelfGrantError("a rep cannot grant themselves a role — the grantor must be someone else");
  }
  if (e?.constraint === "rep_role_no_self_revoke") {
    return new SelfGrantError("a rep cannot revoke their own role — the revoker must be someone else");
  }
  if (msg.includes("last administrator")) return new LastAdministratorError(msg);
  if (msg.includes("was already revoked")) return new GrantAlreadyRevokedError(msg);
  if (msg.includes("append-only") || msg.includes("may be updated") || msg.includes("permitted update")) {
    return new GrantImmutableError(msg);
  }
  return err instanceof Error ? err : new Error(String(err));
}
