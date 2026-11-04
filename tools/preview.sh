#!/usr/bin/env bash
# tools/preview.sh [--keep] [--real]: run Strata on a throwaway DB with a fake model (PORT, default 8804).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8804}"
DB="${STRATA_PREVIEW_DB:-$(mktemp -d)/strata-preview.db}"
KEEP=0; REAL=0
for a in "$@"; do
  case "$a" in
    --keep) KEEP=1; DB="${TMPDIR:-/tmp}/strata-preview.db" ;;
    --real) REAL=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

NODE="$(command -v node)"
export STRATA_PORT="$PORT" STRATA_OPEN=1 STRATA_DB="$DB"
export STRATA_COURSES="$PWD/test/fixtures/courses"
# Keep the generated book's bookmarks as sections so the smoke can exercise PDF navigation.
export STRATA_MIN_SECTION_WORDS="${STRATA_PREVIEW_MIN_SECTION_WORDS:-100}"
# Set the key empty, not unset: distilling reads it directly and the shell may carry a real one.
if [ "$REAL" != "1" ]; then export STRATA_FAKE_MODEL=1 GEMINI_API_KEY=""; fi

# Replace only a node process listening on our port, and wait on our own pid, never just the port.
listeners="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2, $1}' | sort -u || true)"
if [ -n "$listeners" ]; then
  node_pids="" others=""
  while read -r pid cmd; do
    [ -z "$pid" ] && continue
    case "$cmd" in node*) node_pids="$node_pids $pid" ;; *) others="$others $cmd($pid)" ;; esac
  done <<< "$listeners"
  if [ -n "$others" ]; then
    echo "port $PORT is held by$others — not a strata server, so it stays. PORT=8899 tools/preview.sh runs beside it." >&2
    exit 2
  fi
  echo "· port $PORT is held (pid$node_pids) — taking the old server down"
  kill $node_pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    [ -z "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)" ] && break
    sleep 0.1
  done
  # still there after two seconds of grace: it is not going to leave politely
  still="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$still" ]; then kill -9 $still 2>/dev/null || true; sleep 0.2; fi
fi

# A kept DB seeded by an older demo-seed shows boards the seed no longer makes: start it again.
SEED="$("$NODE" -e 'const h=require("crypto").createHash("sha1");for(const f of process.argv.slice(1))h.update(require("fs").readFileSync(f));console.log(h.digest("hex"))' tools/demo-seed.mjs tools/fixture-pdf.mjs)"
if [ "$KEEP" = "1" ] && [ -s "$DB" ] && [ "$(cat "$DB.seed" 2>/dev/null)" != "$SEED" ]; then
  echo "· the kept DB was seeded by an older tools/demo-seed.mjs — starting it fresh"
  rm -f "$DB" "$DB-wal" "$DB-shm"
fi

echo "preview db: $DB"

# Build now and watch web/: a preview never serves a dist/ built from older source.
[ -d node_modules ] || { echo "· no node_modules — run npm install first" >&2; exit 2; }
"$NODE" tools/build.mjs
"$NODE" tools/build.mjs --watch & WATCH=$!

"$NODE" server/main.ts &
SRV=$!
trap 'kill $SRV $WATCH 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 50); do
  # wait on our own server: a dead child must fail loudly, not pass because something else answers
  kill -0 "$SRV" 2>/dev/null || { echo "· the preview server died before it came up — its error is above" >&2; wait "$SRV"; exit 1; }
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.2
done

if [ "$KEEP" = "1" ] && [ -s "$DB" ] && [ "$(curl -fsS "http://127.0.0.1:$PORT/api/boards" | tr -d ' \n')" != '{"boards":[]}' ]; then
  echo "· reusing the boards already in $DB"
else
  "$NODE" tools/demo-seed.mjs "http://127.0.0.1:$PORT"
  echo "$SEED" > "$DB.seed"
fi

echo
echo "  → http://127.0.0.1:$PORT   (ctrl-c to stop; the DB above is disposable)"
wait $SRV
