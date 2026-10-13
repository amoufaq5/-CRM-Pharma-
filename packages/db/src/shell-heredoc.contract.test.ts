import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A backtick inside an UNQUOTED heredoc is a command, not punctuation.
 *
 * WHAT THIS CAUGHT. `scripts/verify-client-live.sh` seeds its fixtures through
 * `psql … <<SQL`, unquoted because `$TENANT` has to expand — which means the whole body is
 * expanded, which means a backtick in it is command substitution. Four identifiers were quoted
 * that way in SQL COMMENTS, so every run of that gate really did execute `work_email_hint`,
 * `Warehouse`, `SnapshotRefresher` and two script names. Harmless, because each failed to
 * nothing; invisible, because the stderr went where nobody read it; and found only when the
 * CI job started re-emitting its own output as workflow annotations, where five
 * "command not found" lines appeared under a job that had always looked green.
 *
 * A comment that runs a command is a comment that could run ANY command, and the next person
 * writing prose into one of these heredocs has no reason to know that. So the rule is a test.
 *
 * NO DATABASE and no shell: it reads the scripts and tracks heredoc openers, which is why it
 * lives in `@crm/db` beside the repository's other cross-file guards rather than in a gate that
 * has to be run by hand.
 */
describe("shell heredocs in scripts/", () => {
  const scripts = join(__dirname, "..", "..", "..", "scripts");

  /**
   * Returns one finding per backtick found inside an unquoted heredoc body.
   *
   * The opener is matched loosely on purpose — `<<WORD`, `<<-WORD`, with or without a trailing
   * `|| fail …` — and a quoted opener (`<<'WORD'`) is skipped, because quoting is exactly the
   * thing that makes a body literal and therefore safe.
   */
  const findings = (name: string, text: string): string[] => {
    const out: string[] = [];
    let open: string | null = null;
    text.split("\n").forEach((line, i) => {
      if (open === null) {
        const m = /<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        // A quoted opener means a literal body, which is the safe form.
        if (m !== null && !line.includes(`<<'${m[1]!}'`) && !line.includes(`<<"${m[1]!}"`)) {
          open = m[1]!;
        }
        return;
      }
      if (line.trim() === open) {
        open = null;
        return;
      }
      if (line.includes("`")) out.push(`${name}:${String(i + 1)}: ${line.trim().slice(0, 100)}`);
    });
    return out;
  };

  const files = readdirSync(scripts).filter((f) => f.endsWith(".sh"));

  it("found the scripts, or the assertion below is vacuous", () => {
    // The guard on the guard: this reads a directory, so a wrong path would make it pass by
    // examining nothing — the vacuous-green failure 0066's live gate had to be corrected for.
    expect(files.length).toBeGreaterThan(4);
    expect(files).toContain("verify-client-live.sh");
    expect(files).toContain("verify-live-erp.sh");
  });

  it("carries no backtick inside an unquoted heredoc", () => {
    const all = files.flatMap((f) => findings(f, readFileSync(join(scripts, f), "utf8")));
    expect(
      all,
      "an unquoted heredoc expands its body, so a backtick there runs a command — quote the " +
        "identifier differently, or open the heredoc as <<'SQL' if nothing in it needs expanding",
    ).toEqual([]);
  });

  /**
   * And the detector finds one when there is one, which is the half that makes the test above
   * worth having: a scanner that matched nothing would also report an empty list.
   */
  it("detects the shape it is looking for", () => {
    const sample = [
      "psql <<SQL || fail \"seed\"",
      "-- `work_email_hint` is the column",
      "SELECT 1;",
      "SQL",
      "psql <<'SQL'",
      "-- `this one is literal and fine`",
      "SQL",
    ].join("\n");
    expect(findings("sample.sh", sample)).toEqual([
      "sample.sh:2: -- `work_email_hint` is the column",
    ]);
  });
});
