# Agents (MCP)

Claude Code and Codex reach a Strata room over MCP at `<room>/mcp`: one `POST` per JSON-RPC message,
answered with JSON. There are no sessions and no event stream.

## Connecting

On the Desk, **Connect an agent** makes a named token (read-only, or read and write) and shows it once,
with the command for each client:

```sh
claude mcp add -s user --transport http strata https://<host>/u/<name>/mcp --header "Authorization: Bearer stk_…"
```

```toml
# ~/.codex/config.toml, with STRATA_TOKEN exported in your shell
[mcp_servers.strata]
url = "https://<host>/u/<name>/mcp"
bearer_token_env_var = "STRATA_TOKEN"
```

The room stores only a token's SHA-256. The same page lists tokens with when each was last used, and
revokes them.

## The tools

| Tool | Does |
|---|---|
| `whoami` | The token's access, and the boards with their handles and ids |
| `get_outline` | The light view of anything: children, one line each |
| `get_context` | Everything about one thing: a board, a collection (`<board>/kept`, `/questions`, `/highlights`, `/plan`, `/log`, `/sources`, `/chat`), a source, section, deck, card, question, highlight, group or milestone |
| `get_text` | A source's or section's extracted text, by page range; for a PDF with none, whether its text is waiting to be read from its file, being read, or why it could not be |
| `search` | Batched `{ kind, query }` over cards, kept cards, questions, highlights, sources (newest first, dated), the log, chat |
| `get_changes` | Reviewed, kept, highlighted, asked, answered, added, finished, logged, since a date |
| `get_guide` | The server's own instructions (`server/features/agent/guide.md`), or the reader's own text for a topic they rewrote in Dispatch's Prompts drawer (`agent_prompts`) |
| `request_upload` | A one-time signed upload link per new PDF, Markdown, text or HTML file, or the existing source for known bytes |
| `get_import` | An upload's progress |
| `capture` | A web page, arXiv abstract or YouTube transcript, through the app's own capture; a link the board already holds, however it is written, answers with that source |
| `apply` | A batch of typed operations, all or nothing; each op's fields are in its input schema |
| `create_board` | A new board, with a handle and a purpose |
| `dashboard_add_items` | Tasks into the dashboard's inbox: a title, a line of context and where it came from, for the reader to send on or drop |
| `dashboard_read` | The dashboard as Markdown: every thread by stage (to-do, thinking, decide, implementing, review) with notes and links, then the inbox |
| `dashboard_board` | Dispatch: every open thread as JSON `[{ id, title, stage, claimed? }]`, implementing first; `claimed` says which run holds it |
| `dashboard_open` | Dispatch: one thread `{ id, title, text, stage, page, notes: [{ id, on, text }] }`, the newest version's page and the notes on it; on a thread in implementing it claims the thread for this run (its `Mcp-Session-Id`) for an hour, and is refused while another run holds it |
| `dashboard_post` | Dispatch: `{ page?, replies?, ask?, heard? }`, the next version, the ask it answers and how Claude read it, and replies under the reader's notes |

Every answer is Markdown, cut to about 6k tokens (up to 24k with `max_tokens`), and ends with the exact
call for the next part. Ids carry a prefix (`src_`, `sec_`, `deck_`, `card_`, `q_`, `hl_`, `grp_`, `ms_`,
`imp_`) and a pasted Strata link works anywhere an id does (`shared/agent/ids.ts`).

## Writes

Agents add and arrange; they never delete for good (`delete_deck` tombstones a deck the reader can restore, `add_deck` replaces a section's cards), never keep a card and never write a question's answer.

A deck an agent adds is the deck distil would have made: `add_deck` takes the section's concept tree (one synthesis root, claims with questions, a glossary) with the cards, and each card names its tree node, the questions it answers and the term it introduces. The op checks the shape and nothing about size (one synthesis root, every question answered once, every term defined once), orders definition cards first with `orderByLadder`, and stores the tree as `ready`, so the concept map, drill order and Review's claim are the same for both. A section that already has a tree takes cards without one.

`add_deck` and `set_primer` each need a **guide receipt** (`guide`): a hash of the `flashcards` or `primer` topic of `guide.md`, printed at its end (`server/features/agent/guide.ts`). Without the current one the op is refused with the guide in the error, so an agent can't write a deck or a primer it never read the rules for, and an edit to the guide makes every agent read it again. The receipt hashes the text the agent read, so the reader's own text for a topic has its own.

A card, a tree node and a glossary term are each placed by a verbatim quote of the words they are about and nothing else. `shared/reading/compile-quote.ts` is the one compile step: distil (with the model repairing what fails), `add_deck`, `edit_cards` and the reader all ask it whether a quote occurs exactly once in the card's passage, and an agent's batch with a quote that doesn't compile writes nothing and names why.
Every write tool takes a `key`: the batch commits in one `ctx.commit` together with a receipt under that
key, so a resent call replays the first answer. `apply`'s operations are in `server/features/agent/ops.ts`;
a new one is a new entry there, and both apply's schema and the guide list it automatically.

A source's **primer** (`server/features/primers`) is its first layer: one HTML page, itself a source on the
board, that the reader opens before page 1. The reader asks for one with the Primer button in the reader's bar,
which records the ask in `primers` and wakes the routine; `whoami` lists every ask under **Primers asked for**,
and the routine uploads the page it draws (`get_guide({ topic: "primer" })`) and links it with the `set_primer` op, together with the plan it was drawn from (the reader opens it with `i`),
which clears the ask. How the page looks is left to the model, source by source.

The dashboard (`server/features/dashboard`, page at `<room>/dashboard`) is a separate app the room only
hosts: no board owns it, so it has its own tools instead of `apply` ops. A thread moves by the reader's
hand through three stages, to-do → thinking → review, then done or dropped (`stage`); an older
`backlog` is read as to-do. New work goes through the inbox: `dashboard_add_items` only fills it, with a
title, a line of `context` and where it came from, and the reader keeps each item in to-do, or drops it.
The notes on a thread (`body`) are the reader's own, written in Thinking; no tool edits or moves a
thread. Run now on the board wakes the reader's own scheduled routine through its API trigger
(`server/features/dashboard/routine.ts`): the Fire URL and token are set on the board and never sent
back, a run carries no task list because the routine reads the board itself, and runs are a minute apart.
What the routine does is `get_guide({ topic: "routine" })`; the prompt stored on it only points there.
Setting one up, at claude.ai/code under Routines: the prompt is `You are the Strata routine. Call
get_guide({ topic: "routine" }) on the Strata server and follow it.`; its connectors are the room's MCP server
(a write token) and whatever the work lives in (Linear, Slack, GitHub, Notion); its repositories are the ones
Dispatch threads build in; it runs on a schedule (weekday mornings fill the inbox) and has an API trigger,
whose Fire URL and token go into Connect on the dashboard.
Dispatch (`server/features/dashboard/dispatch.ts`, page at `<room>/dispatch`) is the dashboard's second
mode: the room's own reader with a pane of threads on its left. A thread sent from to-do
goes to `implementing`; each page Claude posts with `dashboard_post` becomes a new version, an HTML source
on the board with the `dispatch` handle (`dashboard_versions`), so every version is kept and the reader's
notes on it are that version's notes, with agent replies under them as `reply_note` writes them. Where a
page lands follows the thread's newest press (`dashboard_presses`): sent, or sent back in Decide → Decide;
Go in Decide → Review; sent back in Review → Review; Go in Review → done. Go and Send back show to the
agent as the newest note, on nothing. Sending and both presses wake the routine as Run now does, and the
session it answered with is kept on the press; `STRATA_ROUTINE_STUB=1` (the preview sets it) logs the wake
instead. Decide and Implementing are reached only this way; Focus leaves Dispatch threads out of its Review.
Every thread is work or personal (`area`): the page shows one area at a time, and an item that names
no area goes where its source suggests. The older `state`, `pinned_at` and `morning_at` columns, the updates,
sources and pad tables stay in the database; nothing writes them but the mirror of `stage`.

`<board>/chat` reads both chat tables, the board's and per-source thread (`messages`) and Ask on a card
(`card_messages`), newest first, cleared turns included and marked. A question asked at words of a source
names them (`asks`, by `messages.ask_id`), and the listing says so. Agents read chat; they never write it.

An upload is `request_upload`, then one `PUT` of the raw bytes to the signed link (15 minutes, one
import), then the ordinary import pump. Agent uploads take the split the picker would suggest; uploads
from the app still wait for you. The same bytes on the same board come back as a duplicate.

An agent's upload or capture is not studied unless it says `study: true`: its sections get trees marked
`unstudied`, nothing is carded, and the reader shows "Generate flashcards" instead of the cards column.
Uploads from the app are studied unless the person turns it off.

A non-PDF file sent again under the same `origin.ref` revises its source in place (`reviseSource` in
`server/features/sources/ingest.ts`): the pump decides at finalize, the revision asked for last wins
whatever order the bytes land in, and the import rows before it are dropped.

## Keeping it in step

- `test/agent-kinds.test.ts`: every table a board or deck owns is read by a kind in
  `server/features/agent/kinds.ts` or listed in `HIDDEN` with a reason.
- `test/integration/agent.test.ts`: the tool list is pinned, and the three journeys run over real MCP
  calls (last reviewed cards; everything on a board, page by page; upload and duplicate).
- `tools/race` scenario `agent-resend`: lost answers resent under one key, an upload cut and resent.
- `tools/perf/agent.mjs`: the reads against the production-sized fixture, budgeted as `agent/*`.

The gateway lets a request through without a login only on `<base>/mcp` with a Bearer header and on
`<base>/api/agent/v1/upload/*`; the room checks the token or the link's signature itself.
