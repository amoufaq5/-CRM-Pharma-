#!/usr/bin/env bash
# Replay the deployment image's build WITHOUT Docker, then run what it produced.
#
# WHY THIS EXISTS. deploy/ was authored in an environment with the Docker CLI and no
# daemon, so `docker build` was impossible and the Dockerfile was verified by reading.
# scripts/verify-deploy-stack.sh held the compose file to a real standard that way and
# said plainly that the image's RUN steps stayed unverified. They did. They were also
# broken in four separate ways, every one of them fatal, for the whole six weeks:
#
#   1. the manifest layer listed 8 of the 16 workspace packages, so the other eight were
#      not pnpm importers, got no node_modules, and `tsc --build` failed with TS2307 on
#      `@crm/db` from inside packages/notify. A clean build emitted no
#      packages/api/dist/bin/api.js at all — the compose file was impeccable and pointed
#      at an entrypoint that could not exist;
#   2. @crm/erasure was absent from the root tsconfig's references, so `tsc --build`
#      never built it and the GDPR Article 17 executor and tombstone signer were missing
#      from the image (and from `pnpm build`);
#   3. `pnpm prune --prod` asks before rewriting node_modules and refuses outright with
#      no TTY, which a docker build does not have. The step could never have run;
#   4. and had it run, it empties every workspace importer's node_modules and relinks
#      only the root, so the api would have died on `Cannot find package '@crm/callplan'`
#      at its first import.
#
# One reason all four survived CI: there was no .dockerignore, so the build context
# carried the host's dist/ and tsconfig.tsbuildinfo. On a developer's machine tsc found
# every project up to date, emitted nothing, and the host's own build output made the
# image look correct. The defects were visible only where nobody was looking.
#
# So this script does the thing reading cannot. It assembles a context from tracked
# files only — no dist/, no node_modules, no tsbuildinfo, which is exactly the guarantee
# .dockerignore now gives the real build — replays both stages of deploy/Dockerfile into
# two directories, and then RUNS the entrypoints out of the second one.
#
# It INTERPRETS the Dockerfile rather than restating it: every COPY and RUN it replays
# is parsed out of the file, and a step it cannot interpret is a failure rather than a
# skip. A paraphrase would have been written from the same wrong list and agreed with it.
#
# WHAT IT STILL DOES NOT PROVE: this is not Docker. The base image and its node, layer
# caching, the builder's network, and whether `USER crm` can read what it was given are
# outside it — CI runs a real `docker compose build` on top. This is what a developer can
# run in thirty seconds, and what would have caught all four on the day each landed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

command -v git  >/dev/null || fail "git not found"
command -v node >/dev/null || fail "node not found"
command -v pnpm >/dev/null || fail "pnpm not found"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

CTX="$WORK/ctx"   # the build context
IMG="$WORK/build" # the build stage's filesystem
RT="$WORK/runtime"  # the runtime stage's — only what it is given
mkdir -p "$CTX" "$IMG" "$RT"

# ---------------------------------------------------------------------------
echo "--- 1. the build context, from tracked files only ---"
# `--cached --others --exclude-standard`: tracked files AND new ones that .gitignore does
# not cover, which is exactly the set `docker build` would send. Tracked-only was the
# first version and it was wrong in a way that bit immediately — a brand-new package is
# untracked until `git add`, so the replay failed on a COPY whose source the real build
# would have had. What .gitignore covers still cannot appear: node_modules/, dist/,
# *.tsbuildinfo, which is the guarantee .dockerignore gives the real build.
git ls-files --cached --others --exclude-standard -z | tar -cf - --null -T - | (cd "$CTX" && tar -xf -)
for pattern in 'node_modules' 'dist' '*.tsbuildinfo'; do
  found="$(find "$CTX" -name "$pattern" | head -1)"
  [ -z "$found" ] || fail "host build output reached the context: $found"
done
ok "context assembled, $(find "$CTX" -type f | wc -l | tr -d ' ') files, no build output in it"

# ---------------------------------------------------------------------------
echo "--- 2. parse deploy/Dockerfile into steps ---"
PLAN="$WORK/plan"
python3 - "$ROOT/deploy/Dockerfile" > "$PLAN" <<'PY'
import re, shlex, sys

text = open(sys.argv[1]).read()

# Join line continuations first, then drop comments and blanks.
joined, buf = [], ""
for raw in text.split("\n"):
    line = raw.rstrip()
    if buf:
        buf += " " + line.lstrip().rstrip("\\").strip()
        if not line.endswith("\\"):
            joined.append(buf)
            buf = ""
        continue
    if line.strip().startswith("#") or not line.strip():
        continue
    if line.endswith("\\"):
        buf = line.rstrip("\\").strip()
        continue
    joined.append(line)

stage, steps, stages = None, [], []
for line in joined:
    m = re.match(r"^FROM\s+\S+(?:\s+AS\s+(\S+))?$", line, re.I)
    if m:
        stage = (m.group(1) or "").lower()
        if not stage:
            sys.exit("a stage without a name cannot be replayed; name it")
        stages.append(stage)
        steps.append(("STAGE", stage, ""))
        continue
    verb = line.split(None, 1)[0].upper()
    rest = line.split(None, 1)[1] if " " in line else ""
    if verb == "USER":
        # One uid here, and it is not ours to change. That the image ENDS on a non-root
        # USER is verify-deploy-stack.sh property 6; whether crm can read what it was
        # given is for the real build in CI.
        continue
    if verb in ("ENV", "WORKDIR", "CMD", "ENTRYPOINT"):
        # CMD is checked against the build output in step 4, not executed here.
        if verb == "CMD":
            steps.append(("CMD", stage, rest))
        continue
    if verb == "RUN":
        cmd = rest.strip()
        if cmd == "corepack enable":
            continue  # the harness already has the pinned pnpm
        if cmd.startswith("useradd"):
            continue  # there is one uid here and it is not ours to change
        # `pnpm …` and `node …` are the repo's own tooling and replay as themselves.
        # Anything else — apt, curl, a shell pipeline — cannot be reproduced honestly
        # here and is a hard stop rather than a skip.
        if not (cmd.startswith("pnpm ") or cmd.startswith("node ") or cmd.startswith("NODE_ENV=production node ")):
            sys.exit(f"cannot replay `RUN {cmd}` outside Docker — teach this script, or "
                     f"keep the RUN steps to pnpm/node and the two exceptions above")
        steps.append(("RUN", stage, cmd))
        continue
    if verb == "COPY":
        parts = shlex.split(rest)
        frm = ""
        kept = []
        for p in parts:
            if p.startswith("--from="):
                frm = p.split("=", 1)[1]
            elif p.startswith("--chown=") or p.startswith("--link"):
                pass  # ownership is Docker's; this harness runs as one user
            elif p.startswith("--"):
                sys.exit(f"cannot replay `COPY {rest}`: unknown flag {p}")
            else:
                kept.append(p)
        *srcs, dest = kept
        steps.append(("COPY", stage, f"{frm}|{' '.join(srcs)}|{dest}"))
        continue
    sys.exit(f"unhandled instruction: {line}")

if [s for s in steps if s[0] == "RUN"] == []:
    sys.exit("parsed no RUN steps at all — the parser is wrong")
for s in steps:
    print("\t".join(s))
PY
grep -c . "$PLAN" >/dev/null
sed -n 's/^/    /p' "$PLAN"

# ---------------------------------------------------------------------------
echo "--- 3. replay both stages ---"
# Each stage gets its own directory. The runtime stage therefore has EXACTLY what its
# COPY lines give it and nothing else — which is the only way to find out whether the
# list is complete, and the reason step 5 runs the entrypoints from there rather than
# from the build stage, where every file in the repository is lying around.
# One directory per stage, created on demand. Hard-coding build and runtime meant a
# third target — the `web` stage that carries the app bundle — failed here rather than
# being replayed, which is the wrong way round for a script whose job is to follow the
# Dockerfile wherever it goes.
dir_for() {
  case "$1" in
    build) echo "$IMG" ;;
    runtime) echo "$RT" ;;
    *) mkdir -p "$WORK/stage-$1"; echo "$WORK/stage-$1" ;;
  esac
}

while IFS=$'\t' read -r verb stage arg; do
  case "$verb" in
    STAGE) echo "    [$stage]" ;;
    COPY)
      IFS='|' read -r frm srcs dest <<<"$arg"
      from_dir="$CTX"; [ -z "$frm" ] || from_dir="$(dir_for "$frm")"
      to_dir="$(dir_for "$stage")"
      target="$to_dir/${dest#./}"
      case "$dest" in */) mkdir -p "$target" ;; *) mkdir -p "$(dirname "$target")" ;; esac
      for src in $srcs; do
        abs="$from_dir/${src#/app/}"
        [ -e "${abs%/}" ] || fail "COPY source does not exist: $src (stage $stage)"
        case "$src" in
          */) cp -a "${abs%/}/." "$target" ;;
          *)  cp -a "$abs" "$target" ;;
        esac
      done
      ;;
    RUN)
      ( cd "$(dir_for "$stage")" && eval "$arg" ) >"$WORK/run.log" 2>&1 || {
        tail -25 "$WORK/run.log" >&2
        fail "the image's own build step failed in stage $stage: $arg"
      }
      ;;
    CMD) ;;
  esac
done < "$PLAN"
ok "both stages replayed clean"

# ---------------------------------------------------------------------------
echo "--- 4. every entrypoint anything promises exists in the runtime stage ---"
# Three independent sources name built files, written by three different people at three
# different times, and nothing held them together: the compose file's `command`, the
# Dockerfile's CMD, and each package.json's `bin`. Compose named
# packages/api/dist/bin/api.js while the build produced no such file; @crm/erasure
# declared crm-erasure while never being built at all.
ENTRY_LIST="$WORK/entrypoints"
: > "$ENTRY_LIST"
python3 - "$ROOT/deploy/docker-compose.yml" >> "$ENTRY_LIST" <<'PY'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
for name, svc in (c.get("services") or {}).items():
    cmd = svc.get("command")
    if isinstance(cmd, str):
        cmd = cmd.split()
    if cmd and cmd[0] == "node":
        print(f"compose:{name}\t{cmd[1]}")
PY
python3 - >> "$ENTRY_LIST" <<'PY'
import json, pathlib
for d in sorted(pathlib.Path("packages").iterdir()):
    pj = d / "package.json"
    if not pj.exists():
        continue
    for name, path in (json.loads(pj.read_text()).get("bin") or {}).items():
        print(f"bin:{name}\tpackages/{d.name}/{path.lstrip('./')}")
PY
awk -F'\t' '$1=="CMD"' "$PLAN" | python3 -c "
import sys, shlex, json
for line in sys.stdin:
    _, stage, rest = line.rstrip('\n').split('\t', 2)
    argv = json.loads(rest) if rest.strip().startswith('[') else shlex.split(rest)
    if argv and argv[0] == 'node':
        print(f'dockerfile:CMD\t{argv[1]}')
" >> "$ENTRY_LIST"

count=0
services=0
while IFS=$'\t' read -r who path; do
  [ -n "$path" ] || continue
  [ -f "$RT/$path" ] || fail "$who promises $path, and the runtime stage has no such file"
  ok "$who → $path"
  count=$((count + 1))
  case "$who" in compose:*) services=$((services + 1)) ;; esac
done < "$ENTRY_LIST"
[ "$services" -ge 3 ] || fail "only $services node services found in compose; expected migrate, api and scheduler at least"
[ "$count" -ge 8 ] || fail "only $count promised entrypoints checked; the parsers have stopped finding things"
ok "$count promised entrypoints, all present"

# ---------------------------------------------------------------------------
echo "--- 5. the runtime stage can actually load them ---"
# The build stage installs dev dependencies and the runtime stage must not ship them, so
# the graph the entrypoints resolve against is narrower than the one that compiled them.
# A dependency in the wrong section of a package.json survives every typecheck and fails
# on the first import in production — and `pnpm prune --prod` removed every workspace
# link outright, which no amount of reading the Dockerfile revealed.
#
# Each entrypoint runs with an EMPTY environment and must get far enough to complain
# about configuration. A module-resolution error means the image is broken; a missing
# PGDATABASE means it is fine and was simply given nothing to connect to.
while IFS=$'\t' read -r who path; do
  case "$who" in compose:*|dockerfile:CMD) ;; *) continue ;; esac
  out="$( cd "$RT" && timeout 20 env -i PATH="$PATH" NODE_ENV=production node "$path" 2>&1 || true )"
  case "$out" in
    *ERR_MODULE_NOT_FOUND*|*"Cannot find package"*|*"Cannot find module"*|*ERR_REQUIRE_ESM*)
      printf '%s\n' "$out" | head -6 >&2
      fail "$who cannot resolve its own modules in the runtime stage"
      ;;
    "") fail "$who produced no output at all with an empty environment; expected a configuration complaint" ;;
  esac
  ok "$who loads, and fails on configuration rather than resolution"
done < "$ENTRY_LIST"

# ---------------------------------------------------------------------------
echo "--- 6. the runtime stage carries no build toolchain ---"
# Not hygiene: tsc and vitest in a production image are a larger attack surface and a
# signal that the dev/prod split silently stopped working.
for tool in typescript vitest; do
  [ ! -e "$RT/node_modules/$tool" ] || fail "$tool shipped in the runtime stage"
done
ok "no typescript, no vitest"

# The migrations are data the migrate step reads at runtime, not compiled output, so
# they come from the context rather than the build stage — one more promise worth
# holding, since a runtime stage that forgot them fails only on first deploy.
[ -d "$RT/db/migrations" ] || fail "the runtime stage has no db/migrations; the migrate step would find nothing to apply"
migs="$(find "$RT/db/migrations" -name '*.sql' | wc -l | tr -d ' ')"
ctx_migs="$(find "$CTX/db/migrations" -name '*.sql' | wc -l | tr -d ' ')"
[ "$migs" = "$ctx_migs" ] || fail "runtime stage has $migs migrations, the repository has $ctx_migs"
ok "$migs migrations present"

# ---------------------------------------------------------------------------
echo "--- 7. the web stage carries the app the edge serves ---"
# The Caddyfile serves /srv and proxies /v1 to the api, which is the arrangement that
# keeps both sides free of CORS. An empty /srv would mean a deployed stack whose edge
# answers 404 for the app while every API route works — green everywhere, useless.
WEB="$WORK/stage-web"
if [ -d "$WEB" ]; then
  for file in srv/index.html srv/app.js srv/sw.js srv/config.json srv/manifest.webmanifest; do
    [ -f "$WEB/$file" ] || fail "the web stage has no $file; the edge would serve nothing"
  done
  grep -q "__DEV_TOKEN_LOGIN__" "$WEB/srv/app.js" \
    && fail "the production bundle still contains the dev-token placeholder; the define did not apply"
  grep -q "dev-token" "$WEB/srv/app.js" \
    && fail "the production bundle still contains the paste-a-token login path"
  ok "the web stage serves the app, and the paste-a-token path is compiled out of it"
else
  fail "the Dockerfile declares no web stage; the app would not be served anywhere"
fi

echo
echo "image replayed without Docker: $(find "$RT/packages" -path '*/dist/*' -name '*.js' | wc -l | tr -d ' ') modules, $count entrypoints, all loadable"
echo "still unproven here: the base image, layer caching, the builder's network, USER crm — CI builds for real"
