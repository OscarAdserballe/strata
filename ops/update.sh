#!/bin/sh
# ops/update.sh: one pass of the updater (compose profile autoupdate). Run from the compose directory.
set -eu

state=/tmp/strata-update
mkdir -p "$state"

container() { docker compose ps -aq strata; }

# Every room's database, through SQLite's online backup, into /backups/<room>/; then thin out old ones.
backup_all() {
  stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  # shellcheck disable=SC2016  # the script runs inside the container, where $d and $room expand
  docker exec -e STAMP="$stamp" "$(container)" sh -c '
    need_kb="$(du -sk /data | cut -f1)"; free_kb="$(df -Pk /backups | awk "NR==2{print \$4}")"
    if [ "$free_kb" -lt "$need_kb" ]; then echo "update: only ${free_kb} KB free for backups, need ${need_kb} KB" >&2; exit 1; fi
    failed=0
    for d in /data/*/; do
      [ -f "$d/strata.db" ] || continue
      room="$(basename "$d")"
      mkdir -p "/backups/$room"
      if STRATA_DATA="/data/$room" node tools/backup.mjs "/backups/$room/strata-$room-$STAMP.db" >/dev/null \
        && node tools/prune-backups.mjs "/backups/$room" >/dev/null; then echo "update: backed up $room"
      else echo "update: backing up $room failed" >&2; failed=1; fi
    done
    exit "$failed"'
}

# Docker flips a slow room to "unhealthy" while it is still loading, so only an exit ends the wait early.
wait_healthy() {
  i=0
  while [ "$i" -lt 120 ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(container)" 2>/dev/null || echo missing)"
    [ "$status" = healthy ] && return 0
    [ "$status" = exited ] && return 1
    i=$((i + 1)); sleep 2
  done
  return 1
}

today="$(date -u +%F)"
if [ "$(cat "$state/backed-up" 2>/dev/null || true)" != "$today" ]; then
  backup_all && echo "$today" > "$state/backed-up"
fi

image="$(docker compose config --images | head -n1)"
docker pull -q "$image" >/dev/null 2>&1 || { echo "update: could not pull $image; staying on the running image"; exit 0; }
new="$(docker image inspect --format '{{.Id}}' "$image")"
old="$(docker inspect --format '{{.Image}}' "$(container)")"
[ "$new" != "$old" ] || exit 0
[ "$new" != "$(cat "$state/refused" 2>/dev/null || true)" ] || exit 0

echo "update: $image changed, $old -> $new"
backup_all || { echo "update: not updating without a backup" >&2; exit 1; }
echo "$today" > "$state/backed-up"
docker tag "$old" strata-previous:rollback
docker compose up -d --no-deps strata
if wait_healthy; then
  docker image prune -f >/dev/null 2>&1 || true
  echo "update: running $new"
  exit 0
fi

echo "update: $new did not become healthy; rolling back to $old" >&2
echo "$new" > "$state/refused"
STRATA_IMAGE=strata-previous:rollback docker compose up -d --no-deps strata
wait_healthy || echo "update: the previous image is not healthy either" >&2
exit 1
