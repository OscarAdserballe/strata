# Data layer

Production runs over a tailnet, where answers arrive late, out of order or not at all. A lost
answer and a failed write look the same to the client, so every write must be safe to send twice,
and every read must be ordered against the writes it may have missed.

## Server

- **Revisions.** One counter, `room_rev`, rises on every write to a table a board or deck is built
  from. SQLite triggers (`server/platform/db/revisions.ts`) copy the new value into the scopes the
  row belongs to: `boards.rev`, `boards.plan_rev`, `courses.rev`, or a document's own `rev`. The
  triggers run inside the writing statement's transaction, so jobs, migrations and scripts can't
  forget them. Every API answer carries the counter in `X-Strata-Rev`.
- **Receipts.** A write may carry `Idempotency-Key`. Its rows and the stored answer commit in one
  synchronous `ctx.commit(fn)`; nothing inside may `await`. The same key with the same request
  replays the answer; with a different request it is a 422. Every write route states its mode
  (`atomic`, `stream`, `none`, `exempt`) and a test fails if one doesn't.
- **Streaming.** A chat turn commits the question and an open receipt before calling the model, and
  the reply in a second commit, so a cut stream loses neither and stores neither twice.
- **If-Match.** Writes that replace a whole document (board notes, plan, a tree, card faces, your
  card's text, a source's sections) send the rev they were based on. A stale rev is a 409 carrying
  the current value; nothing is written.
- **Re-sectioning.** A new split of a source keeps a section's id where it covers the same text, and
  otherwise gives each old id to the new section sharing the most text with it. A section that
  loses its id moves its kept cards, under their own ids, into the section its text went to; a
  deck's rebuild replaces only the cards whose ids it minted.

## Client

- **One store** (`web/data/store.ts`). Each piece of server data has one key (`board:<id>`,
  `marks:<id>`, `notes:<id>`, `card:<id>`, …). An answer older than what the key holds is dropped;
  the offline copy never replaces a network answer; a new server epoch resets the ordering.
- **Layers.** What you see is the confirmed value with pending writes folded over it, in order. A
  confirmation and the removal of its layer land in one notification.
- **Invalidation.** A write marks the queries it affects stale when it starts; once it settles at
  rev *s*, any answer stamped below *s* is discarded and watched queries are read again.
- **One save path** (`web/data/mutate.ts`). Every write is an op: it waits in the FIFO lanes it
  names (`mark:<id>`, `notes:<board>`, `grades`…), carries one key minted once and reused on every
  retry, and is retried on a lost answer, timeout, 408/425/429 or 5xx. A 409 rebuilds the op once
  from the current value; any other 4xx rolls back and says why. Offline, writes are refused rather
  than queued. Unsent writes flush with `keepalive` when the page hides.

## Checked by

- `test/integration/receipts.test.ts`, `revisions.test.ts`, `concurrency.test.ts`, `receipt-modes.test.ts`
- `web/data/store.test.ts`, `web/data/mutate.test.ts`
- `tools/race/scenarios.mjs`: each journey ends in invariants checked against the server's database
