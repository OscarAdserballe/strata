#!/usr/bin/env bash
# bash tools/perf/run-all.sh [RUNS] [BASE]: full measurement pass against a running Strata (default :8899)
set -euo pipefail
cd "$(dirname "$0")"
RUNS="${1:-5}"; BASE="${2:-http://127.0.0.1:8899}"
STAMP="$(date +%Y%m%d-%H%M%S)"; OUT="out/full-$STAMP"
MAIN="home,board,pdf-large,pdf-marked,scroll-large,scroll-marked,highlight,prose,chat,flip-prose,flip-pdf"
node survey.mjs "$BASE" > targets.json
node run.mjs --base "$BASE" --engine chromium --scenarios "$MAIN" --runs "$RUNS" --throttle 1,4 --profile --out "$OUT/chromium"
node run.mjs --base "$BASE" --engine chromium --scenarios idle --throttle 1,4 --out "$OUT/idle"
node run.mjs --base "$BASE" --engine chromium --scenarios sw --runs 3 --throttle 1 --out "$OUT/sw"
[ -d dist-prof ] || node build-profiling.mjs
node run.mjs --base "$BASE" --engine chromium --scenarios "$MAIN,idle" --runs 2 --throttle 1 --react-profiling ./dist-prof --out "$OUT/react"
node run.mjs --base "$BASE" --engine webkit --scenarios "$MAIN" --runs "$RUNS" --throttle 1 --out "$OUT/webkit"
node report.mjs "$OUT/chromium" "$OUT/idle" "$OUT/sw" "$OUT/react" "$OUT/webkit" > "$OUT/report.txt"
echo "report: $OUT/report.txt"
