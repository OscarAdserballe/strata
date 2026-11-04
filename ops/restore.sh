#!/usr/bin/env bash
# ops/restore.sh ROOM BACKUP.db [COURSES_DIR]: seed an empty room from a backup; never replaces a database.
# Run it from the directory holding compose.yaml.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 ROOM BACKUP.db [COURSES_DIR]" >&2
  exit 2
fi
room="$1"
[[ "$room" =~ ^[a-z0-9-]+$ ]] || { echo "a room is a lowercase account name: $room" >&2; exit 2; }
backup_dir="$(cd "$(dirname "$2")" && pwd -P)"
backup="$backup_dir/$(basename "$2")"
[ -f "$backup" ] || { echo "backup not found: $backup" >&2; exit 2; }

mounts=(-v "$backup:/restore/strata.db:ro")
copy_courses=''
if [ "$#" -eq 3 ]; then
  courses="$(cd "$3" && pwd -P)"
  mounts+=(-v "$courses:/restore/courses:ro")
  copy_courses="mkdir -p /data/$room/courses; cp -a /restore/courses/. /data/$room/courses/"
fi

compose=(docker compose)
"${compose[@]}" run --rm --no-deps "${mounts[@]}" --entrypoint node strata tools/check-db.mjs /restore/strata.db
"${compose[@]}" run --rm --no-deps "${mounts[@]}" --entrypoint sh strata -ec \
  "if [ -e /data/$room/strata.db ] || [ -e /data/$room/strata.db-wal ]; then echo 'refusing to replace an existing database' >&2; exit 1; fi; mkdir -p /data/$room; cp /restore/strata.db /data/$room/strata.db; chmod 600 /data/$room/strata.db; $copy_courses"
echo "restored $room; add it to secrets/strata_accounts.json if it is new, then restart: docker compose restart strata"
