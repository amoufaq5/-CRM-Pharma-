/**
 * Reading the target record back, to decide whether an ambiguous write landed.
 *
 * Nothing here classifies anything. It asks the ERP one question — "do you hold
 * this id?" — and reports the answer, or reports that it could not get one. The
 * decision about what each answer means belongs to `outcome.ts`, and the decision
 * about when to ask belongs to `dispatch.ts`.
 */

/** What a probe read learned about the target record. */
export type ProbeVerdict =
  | { readonly kind: "present"; readonly record: Record<string, unknown> }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The one ERP capability a probe needs: read a record by its id, `null` when the
 * ERP does not hold it. `ErpClient.get` satisfies this already — no new ACL
 * method was added for the probe, and none is needed.
 */
export interface ProbeReader {
  get(tenantId: string, entity: string, id: string): Promise<unknown>;
}

export interface ProbeTarget {
  readonly tenantId: string;
  readonly entity: string;
  readonly recordId: string;
}

/**
 * The probe's own deadline, deliberately shorter than `ErpClient`'s 15s request
 * timeout.
 *
 * A probe runs on a path that has ALREADY failed, so its cost is pure addition to
 * a drain that is behind. An unanswered probe and a probe never sent lead to the
 * same place — the row retries — so waiting the full client timeout for one buys
 * nothing and doubles the stall when the ERP is hung rather than down. Five
 * seconds is enough for a primary-key read against a server that is answering at
 * all.
 */
export const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeOptions {
  readonly timeoutMs?: number;
}

/**
 * Asks the ERP whether it holds `target.recordId`.
 *
 * Never throws and never retries. Retrying here would recurse into the problem it
 * exists to settle: the probe is itself a request that can fail ambiguously, and a
 * probe of a probe answers nothing. One read, one verdict — and an inconclusive
 * read is reported as such rather than guessed either way.
 */
export async function probeTargetRecord(
  reader: ProbeReader,
  target: ProbeTarget,
  options: ProbeOptions = {},
): Promise<ProbeVerdict> {
  const budget = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // No separate rejection guard on the read, and none is needed: `Promise.race`
    // subscribes to every input, so a read that rejects AFTER the budget expired has
    // been observed and does not reach Node's unhandled-rejection handler. Verified,
    // because the obvious defensive `.catch` would have been untestable dead code.
    const answer = await Promise.race([
      reader
        .get(target.tenantId, target.entity, target.recordId)
        .then((value: unknown) => ({ answered: true as const, value })),
      new Promise<{ readonly answered: false }>((resolve) => {
        timer = setTimeout(() => resolve({ answered: false }), budget);
      }),
    ]);

    if (!answer.answered) {
      return { kind: "unknown", reason: `the probe read did not answer within ${budget}ms` };
    }
    if (answer.value === null || answer.value === undefined) return { kind: "absent" };
    if (typeof answer.value === "object" && !Array.isArray(answer.value)) {
      return { kind: "present", record: answer.value as Record<string, unknown> };
    }
    // A 200 carrying something that is not a record is not evidence of one. Reported
    // as inconclusive rather than as presence, because the whole point of the probe
    // is to replace a guess with an answer.
    return {
      kind: "unknown",
      reason: `the probe read answered with ${Array.isArray(answer.value) ? "an array" : typeof answer.value}, not a record`,
    };
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
