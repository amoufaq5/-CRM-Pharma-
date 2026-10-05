#!/usr/bin/env bash
# Typecheck the TEST files, which `pnpm typecheck` does not.
#
# WHY THIS EXISTS. Every package's tsconfig excludes `src/**/*.test.ts` — correctly, so
# tests are not emitted into dist — and vitest transpiles without typechecking. The
# consequence went unnoticed for a long time: not one of this repo's ~850 tests was ever
# typechecked, in a codebase whose stated discipline is strict TypeScript with no `any`.
#
# What that hid, found the day this script was written: `outcome.test.ts` typed its
# ErpError `kind` parameter through `Parameters<typeof ErpError>`. A class is not
# callable, so that fails its constraint and the parameter collapsed to `never` — so the
# test that proves ERP write-guard codes are told apart by CODE and not by status was
# providing exactly no type safety on the codes. `scheduler.contract.test.ts` had the
# same mistake via `typeof X.prototype.constructor`. Both pass at runtime; both were
# lying about what they checked.
#
# Per package rather than one root project, because each tsconfig carries its own
# references and lib settings and the errors are only meaningful against those.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The per-package config this writes is a transient, and an interrupted run used to leave
# one behind — which is how `packages/sample/tsconfig.typecheck-tests.json` turned up as an
# untracked file and came one `git add -A` away from being committed as though it were
# source. The trap cleans up on any exit, including Ctrl-C and a failure mid-loop;
# `.gitignore` is the belt under it. A generated file in a repository is worse than a
# missing one: the next reader cannot tell it from something they are meant to edit.
cleanup() { rm -f packages/*/tsconfig.typecheck-tests.json; }
trap cleanup EXIT INT TERM

status=0
for dir in packages/*/; do
  pkg="$(basename "$dir")"
  [ -f "$dir/tsconfig.json" ] || continue
  # No src/ (e.g. the shared config package) means nothing to check.
  [ -d "$dir/src" ] || continue

  cfg="$dir/tsconfig.typecheck-tests.json"
  cat > "$cfg" <<'JSON'
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "emitDeclarationOnly": false },
  "include": ["src/**/*.ts"],
  "exclude": []
}
JSON
  out="$( (cd "$dir" && npx tsc -p tsconfig.typecheck-tests.json 2>&1) || true )"
  rm -f "$cfg"

  if [ -n "$out" ]; then
    echo "--- $pkg ---"
    printf '%s\n' "$out"
    status=1
  else
    printf 'ok: %s\n' "$pkg"
  fi
done

[ "$status" -eq 0 ] || { echo; echo "test files do not typecheck" >&2; exit 1; }
echo
echo "every test file typechecks"
