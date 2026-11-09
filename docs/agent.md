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

## The fifteen tools

| Tool | Does |
|---|---|
| `whoami` | The token's access, and the boards with their handles and ids |
| `get_outline` | The light view of anything: children, one line each |
| `get_context` | Everything about one thing: a board, a collection (`<board>/kept`, `/questions`, `/highlights`, `/plan`, `/log`, `/sources`, `/chat`), a source, section, deck, card, question, highlight, group or milestone |
| `get_text` | A source's or section's extracted text, by page range; for a PDF with none, whether its text is waiting to be read from its file, being read, or why it could not be |
| `search` | Batched `{ kind, query }` over cards, kept cards, questions, highlights, sources (newest first, dated), the log, chat |
| `get_changes` | Reviewed, kept, highlighted, asked, answered, added, finished, logged, since a date |
| `get_guide` | The server's own instructions (`server/features/agent/guide.md`) |
| `request_upload` | A one-time signed upload link per new PDF, Markdown, text or HTML file, or the existing source for known bytes |
| `get_import` | An upload's progress |
| `capture` | A web page, arXiv abstract or YouTube transcript, through the app's own capture |
| `apply` | A batch of typed operations, all or nothing; each op's fields are in its input schema |
| `create_board` | A new board, with a handle and a purpose |
| `dashboard_add_items` | Tasks into the dashboard's inbox: a title, a line of context and where it came from, for the reader to send on or drop |
| `dashboard_edit_tasks` | Tasks already on the dashboard, changed in place when the reader asked: title, links, stage, area, all or nothing |
| `dashboard_read` | The dashboard as Markdown: every task by stage (backlog, to-do, thinking, review) with notes, links and subtasks, then the inbox |

Every answer is Markdown, cut to about 6k tokens (up to 24k with `max_tokens`), and ends with the exact
call for the next part. Ids carry a prefix (`src_`, `sec_`, `deck_`, `card_`, `q_`, `hl_`, `grp_`, `ms_`,
`imp_`) and a pasted Strata link works anywhere an id does (`shared/agent/ids.ts`).

## Writes

Agents add and arrange; they never delete for good (`delete_deck` tombstones a deck the reader can restore, `add_deck` replaces a section's cards), never keep a card and never write a question's answer.

A card is placed by a verbatim quote of the words it asks about and nothing else. `shared/reading/compile-quote.ts` is the one compile step: distil (with the model repairing what fails), `add_deck`, `edit_cards` and the reader all ask it whether a quote occurs exactly once in the card's passage, and an agent's batch with a quote that doesn't compile writes nothing and names why.
Every write tool takes a `key`: the batch commits in one `ctx.commit` together with a receipt under that
key, so a resent call replays the first answer. `apply`'s operations are in `server/features/agent/ops.ts`;
a new one is a new entry there, and both apply's schema and the guide list it automatically.

The dashboard (`server/features/dashboard`, page at `<room>/dashboard`) is a separate app the room only
hosts: no board owns it, so it has its own tools instead of `apply` ops. A task is a thread the reader
moves forward by hand through four stages, backlog → to-do → thinking → review, then done or dropped
(`stage`; the older `state` column mirrors it, open stages reading as `you`). A to-do thread may carry
`morning_at`, the reader's pick for tomorrow morning; picking a backlog thread lifts it into to-do.
New work goes through the inbox: `dashboard_add_items` only fills it, with a title, a line of `context`
and where it came from, and the reader sends each item to the backlog or to-do, or drops it. The notes
on a thread (`body`) are the reader's own, written in Thinking; an agent's notes sent as an update go
under them, never over them. Subtasks, fragments and updates are still accepted and on their way out.
`dashboard_edit_tasks` changes tasks already kept when the reader asked; it never pins, clears or
deletes, and each field it leaves out stays as it was.
Run now on the board wakes the reader's own scheduled routine through its API trigger
(`server/features/dashboard/routine.ts`): the Fire URL and token are set on the board and never sent
back, a run carries no task list because the routine reads the board itself, and runs are a minute apart.
Every task is work or personal (`area`): the page shows one backlog at a time, and an item that names
no area goes where its source suggests. `dashboard_read` also carries the reader's scratch pad as plain
text and the `sources` an agent said it read; both are kept for now and go when the older tools do.

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
