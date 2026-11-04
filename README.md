# Strata

A self-hosted reading room for studying. You read a PDF, an article, a transcript or a live HTML page, and
everything that belongs to a passage lies over the page as a sheet tied to it: the cards distilled from it, your
notes, the questions you ask and their answers. Each course keeps a running log. The cards you choose to keep come
back on a spaced schedule. An agent can read the whole room and write into it through the same paths you use.

## Principles

1. **The text is the centre.** Cards, notes, questions and answers lie over the page as sheets tied to the
   passage they are about. Nothing takes you to another screen to think about what you just read.
2. **You choose what to keep.** Cards are distilled for you, but only the ones you keep enter review.
   The kept set is what you know; the rest is scaffolding.
3. **A course is a running log, not a folder.** Each board has a log that moves forward, and the room's
   agent writes into it.
4. **Agents see what a board holds, and no more.** Every table a board owns is a kind the agent can read,
   and every change it makes is an op through the save path a person uses. See [docs/agent.md](docs/agent.md).
5. **One person, one process, one file.** A room is a SQLite file and its own process. A backup is a file
   copy, and so is moving out.
6. **Every write is idempotent and ordered**, so a slow or lossy network loses nothing. The race gate exists
   because this was once false. See [docs/data-layer.md](docs/data-layer.md).
7. **Speed is a feature with a budget.** Hot journeys have ceilings, production is timed on real devices,
   and a change that passes every check but makes the room slower is a regression.
8. **Self-hosted, and honest about what it calls out to.** One container, your own key for the model,
   optional keys for the rest, and nothing phones home.

The engineering rules behind these, and the checks that hold them, are in [AGENTS.md](AGENTS.md).

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
