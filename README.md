# Strata

description coming soon

## Run it

Needs Node 24 and a Gemini API key.

```sh
npm install
npx playwright install chromium    # only for the browser checks
tools/preview.sh                   # a throwaway room on :8804, seeded, with a fake model
```

In Docker: one container, where a login gateway starts a private room (its own process and SQLite
file under `/data/<name>`) for each account in the accounts file. Everything that is yours lives in `.env` and
`secrets/strata_accounts.json`; the tree names no host, account or tool.

```sh
cp .env.example .env                                         # add GEMINI_API_KEY
cp secrets/strata_accounts.example.json secrets/strata_accounts.json
docker compose up -d                                         # the published image, on http://127.0.0.1:8080
docker compose up -d --build                                 # or build this checkout instead
```

### On a server

A server needs no checkout: copy `compose.yaml`, write `.env` and `secrets/strata_accounts.json` beside it, and
start it with the updater.

```sh
mkdir -p backups && sudo chown 1000 backups                 # the room writes its backups as uid 1000
docker compose --profile autoupdate up -d
```

Every minute the updater pulls the published image. Once a day, and before every update, it backs up every room
into `backups/<room>/` (SQLite's online backup, integrity-checked, thinned out over time). When the image changes it
recreates the container, waits up to four minutes for it to be healthy, and rolls back to the previous image if it
isn't. `GET /api/health` reports the running `build`. Its logic is `ops/update.sh`, which ships inside the image, so
it updates along with Strata. The data lives in the Docker volume `strata-rooms`; no update touches it.

`ops/restore.sh ROOM BACKUP.db`, run from the same directory, seeds an empty room from a backup.

## How it's built

- `web/`: React client. `surfaces/` are screens, `capabilities/` the verbs they share, `engines/`
  the React-free drawing code (the PDF reader), `data/` the store and every write, `shell/` the frame.
- `server/`: Node with `node:sqlite`, one folder per feature over `platform/`. `shared/` runs in both.
- Every write is idempotent and ordered; how is in [docs/data-layer.md](docs/data-layer.md).
- Every screen, desktop and phone, is in a Figma file for looking at and discussing the product;
  [FIGMA.md](FIGMA.md) says how it's kept.

## Checks

```sh
npm run verify          # types, lint, unit + integration, browser, race, perf
npm run verify:quick    # types, lint, unit + integration
```

`race` drives real journeys over a seeded slow, lossy network and checks what the server holds.
`perf` drives the hot journeys on a production-sized room against `tools/perf/budgets.json`; CI runs it on every PR
and push and shows the result without blocking.

## Licence

MIT, see [LICENSE](LICENSE). Bundled third-party software and fonts are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
