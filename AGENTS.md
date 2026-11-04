# Working on Strata

Strata has been made slow by changes that passed every check, and has lost writes on a slow
network. The gates below catch both; the rules are what each regression taught.

## Gates

```sh
node tools/verify.mjs            # types · lint · unit + integration · browser · race · perf
node tools/verify.mjs --quick    # types · lint · unit + integration
node tools/verify.mjs --only race   # one stage: types | lint | unit | browser | race | perf
```

Run `--quick` after each step and the whole thing before a PR. Each stage serves its own fresh room.

- **perf** (`npm run perf`): builds, generates a production-sized room (`tools/perf-fixture.mjs`),
  drives the hot journeys and checks `tools/perf/budgets.json`. CI runs it as its own job on every
  push and PR and shows the result; it never blocks, because the same revision can pass one day and
  fail the next on a shared runner. A red perf job is still a thing to read before merging.
  Run it locally for a change to a hot path in `web/`, `public/`, `shared/` or `server/`. Budgets are ceilings
  with headroom, there to catch a journey getting much slower, not to ratchet: a smaller bundle or
  one fewer request doesn't lower one. If a budget fails, fix the cause; if the cost is deliberate,
  raise the budget and say why in the PR.
  `node tools/perf/run.mjs --base <url> --scenarios <names> --profile` shows where time goes.
- **race** (`npm run race`): drives journeys over a seeded slow, lossy network (`tools/race/`) and
  checks invariants against the server's database. `tools/race/known-failures.json` is empty and
  stays empty: a check you break is a bug. A new write path that can race gets a scenario.

## Rules

1. **No fast-changing state at the root.** `web/shell/App.tsx` and `web/shell/BoardRoute.tsx`
   re-render the whole room. State lives in the component that shows it: a screen's in
   `web/surfaces/<screen>/`, a shared verb's in `web/capabilities/<verb>/`.
2. **Polls** check there is something to watch, pause while `document.hidden`, back off when idle,
   and `setState` only when the data changed.
3. **Effects that read layout have a dependency list.**
4. **In the reader, read all layout first, then write.** Paint a page's marks when that page draws
   (`onPageDrawn` in `web/engines/pdf/PdfEngine.ts`), never every page's.
5. **The server is one synchronous thread.** Hot routes don't read `resource_blobs.bytes` or
   `page_text`, don't scan `events`, and don't prepare statements per call: statements live in the
   feature's `repo.ts`, prepared once. Check `EXPLAIN QUERY PLAN` for new queries.
6. **A performance claim in a comment needs a test or a budget.**
7. **The perf fixture stays as big as production.** Grow `tools/perf-fixture.mjs` when production grows.
8. **A click doesn't wait on a round trip it could have started earlier.** Prefetch on idle or
   pointerdown (`prefetch` in `web/data/api.ts`), reuse data already loaded, or paint first and save after.
9. **Server data lives in the store** (`web/data/store.ts`), under one key per piece, read with
   `useEntity`/`useQuery`. No component keeps its own copy.
10. **Every write goes through the save path** (`web/data/mutate.ts`, ops built in
    `web/data/entities/`). Only `web/data/api.ts` touches the network. On the server a write route
    states its receipt mode, writes only inside `ctx.commit(fn)` with no `await`, and a
    whole-document write checks `ctx.ifMatch` first. A new table with `board_id` or `course` gets
    revision triggers. See [docs/data-layer.md](docs/data-layer.md).
11. **Layers import one way** (`test/architecture.test.ts`): the server never imports the client,
    `shared/` imports only itself, engines never reach data or screens, a surface never imports
    another surface, a `repo.ts` holds only statements. Its `ALLOWED` lists only shrink.
12. **Where a thing goes:** an engine draws or computes from values (no store, no API); a
    capability is a verb more than one screen could want; a surface is a route and the state only
    it needs; a server feature is `routes.ts` + `repo.ts` + its logic; code both runtimes run is in
    `shared/`.

13. **Agents see what a board holds.** A new table with `board_id` or `course` gets a kind in
    `server/features/agent/kinds.ts` (or a reason in its `HIDDEN`); a new agent write is an op in
    `server/features/agent/ops.ts`, never a new tool. The one exception is the dashboard
    (`server/features/dashboard`): a separate app the room only hosts, with its own `dashboard_*`
    tools because no board owns it. See [docs/agent.md](docs/agent.md).

## Comments

At most one line, and only for a why the code can't say: a browser quirk, an ordering constraint,
a perf trap. No history, no essays, no links into docs.

## Production is watched

`web/platform/rum.ts` times named journeys on real devices (`begin("name")` where the person acts,
`end("name")` where the result shows) and `web/platform/taps.ts` times every tap and key. The samples
land in each room's `perf_samples` table, where a slow week can be read back.
