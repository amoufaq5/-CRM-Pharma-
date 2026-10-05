#!/usr/bin/env bash
# Run the SMTP client against aiosmtpd — a third-party server, not our own test double.
#
# Skips, loudly and with a zero exit, when Python or aiosmtpd cannot be had. That is
# deliberate: this is a cross-check an operator or a reviewer runs, not a gate, because
# making CI depend on a Python package the repo does not declare would trade a real
# verification for a brittle one. The committed vitest suite covers the protocol against
# our own sink; this is what rules out a mistake the client and that sink share.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${SMTP_CROSSCHECK_VENV:-$ROOT/.smtp-crosscheck-venv}"

skip() { echo "SKIP: $*"; echo "(the committed suite still covers the protocol against the in-repo sink)"; exit 0; }

command -v python3 >/dev/null || skip "python3 not found"
[ -f "$ROOT/packages/notify/dist/smtp.js" ] || { echo "building @crm/notify first" >&2; (cd "$ROOT" && pnpm --filter @crm/notify build >/dev/null); }

if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV" >/dev/null 2>&1 || skip "python3 -m venv failed (python3-venv not installed?)"
  "$VENV/bin/pip" install --quiet aiosmtpd >/dev/null 2>&1 || skip "could not install aiosmtpd (no network?)"
fi
"$VENV/bin/python" -c "import aiosmtpd" 2>/dev/null || skip "aiosmtpd is not importable in $VENV"

echo "cross-checking against $("$VENV/bin/python" -c 'import aiosmtpd; print("aiosmtpd", aiosmtpd.__version__)')"
SMTP_CROSSCHECK_PYTHON="$VENV/bin/python" node "$ROOT/scripts/smtp-crosscheck/crosscheck.mjs"
