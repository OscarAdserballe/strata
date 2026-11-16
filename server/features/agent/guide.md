## overview

Strata is a reading room. Each **board** is a project or course: the sources being read, the flashcards grown from them, and what the reader wrote along the way.

What matters most, in order:

1. **Kept cards** (`<board>/kept`): flashcards the reader starred to hold onto. This is the condensed record of what they know and care about. Seen or drilled counts are not progress; kept is.
2. **The log** (`<board>/log`): the board's home note, a running Markdown log in the reader's own words.
3. **Questions** (`<board>/questions`): open ones are gaps the reader named; answered ones carry the reader's own answer.
4. **Highlights** (`<board>/highlights`, `filter: { noted: true }` for those with notes): quotes and the reader's notes on them, with any replies. Answer under a note with `apply` and `reply_note { id: "hl_…", text }`; the reader sees it at once, under those words.
   **Comments** (`<board>/comments`): threads the reader started on a live page and sent back to you, each with its whole history. "Answer my Strata comments on …" means: read the threads waiting on you, revise the page, reply on each.
5. **The plan** (`<board>/plan`): the purpose, groups of sources and milestones.
6. **Sources**: the files read, with sections (chapters), concept trees and text.
7. **Chat** (`<board>/chat`): the reader's conversations with the board's model, newest first, on the board, a source or a card. A question asked at words of a source names them ("at the words …"). Turns the reader cleared are kept and marked "cleared". It shows what they asked and puzzled over; the model's answers are not the reader's own words.

Start with `whoami` (or `get_outline` with no arguments) to find the board, then `get_context({ id: "<board>" })` for an overview. Use `get_outline` to see what is under something cheaply, and `get_context` when you need all of it. Every answer is cut to a size limit and ends with the exact call that gets the next part.

## ids

Every id says what it is:

| id | what |
|---|---|
| `thesis` or `b-1a2b3c4d` | a board, by its handle or id |
| `thesis/log`, `thesis/plan`, `thesis/kept`, `thesis/questions`, `thesis/highlights`, `thesis/comments`, `thesis/sources`, `thesis/chat` | a board's collections |
| `src_…` | a source |
| `sec_…` | a section (chapter) of a source |
| `deck_…` | a deck of cards |
| `card_…` | one card |
| `q_…` | a question |
| `hl_…` | a highlight |
| `cm_…` | a note on a live page, by its old comment-thread id |
| `grp_…`, `ms_…` | a plan group, a milestone |
| `imp_…` | an upload in progress |

A link copied from Strata (with `?board=…` or `&resource=…`) works anywhere an id does.

Filters narrow a collection without new ids: `{ group, source, since }` on kept, `{ state: "open" | "answered" }` on questions, `{ noted, source }` on highlights, `{ source, state: "open" | "with_agent" | "your_turn" | "resolved" }` on comments (open by default), `{ source, since }` on chat.

## apply

`apply({ board, key, ops })` runs a list of operations all together or not at all. Each op's fields are in apply's input schema; this list repeats them. Pick a fresh `key` for each new batch (any 8–80 letters, digits or dashes); sending the same key again returns the first answer instead of writing twice, so it is safe to retry.

Agents add and arrange. They never delete for good: `delete_deck` sets a deck aside and the reader can put it back, and `add_deck` replaces a section's cards with yours. They never keep a card (keeping is the reader's judgement), and never write a question's answer.

{{OPS}}

A card sits at a verbatim quote of the words it asks about (`at`), and nowhere else: 4 to 40 consecutive words copied exactly from its source, that occur once in its passage (on one page, for a PDF). `add_deck` and `edit_cards` compile every quote before anything is written; one that doesn't compile is an error naming why (not verbatim, occurs twice, outside the passage, too short), and the batch writes nothing, so fix the quotes it names and send it again. A deck's or a card's context shows each card's place and whether it compiles; `get_text` on its section gives the words to quote. `edit_cards` moves a card or rewrites its faces in place: its id, reviews and keep stay.

Example:

```json
{ "board": "thesis", "key": "plan-2026-10-17-a", "ops": [
  { "op": "add_group", "name": "RQ2 retrieval vs long context" },
  { "op": "place", "id": "src_7f3a", "group": "RQ2 retrieval vs long context" },
  { "op": "set_group", "id": "RQ2 retrieval vs long context", "by": "2026-12-01" },
  { "op": "append_log", "text": "Grouped the long-context papers under RQ2." }
] }
```

A board is the reader's project: its groups are its units, read in order, and a source in no group is a loose end. `set_project` gives the project an end date or archives it; `set_group` dates a unit. Dates are YYYY-MM-DD.

## uploads

To add a local file (PDF, Markdown, text or HTML, up to {{MAX_MB}} MB):

1. Compute its SHA-256 and size, for example `shasum -a 256 file.pdf` and `wc -c < file.pdf`.
2. Call `request_upload({ board, key, files: [{ name, bytes, sha256 }], origin: { from: "canvas", ref: "<course/file id>" } })`. Add `study: true` to make flashcards as it arrives.
   - A file already on that board comes back as `duplicate` with its `src_` id and an `open:` link. Nothing more to do.
   - Otherwise you get an `upload_url`. It works for 15 minutes.
3. Send the bytes in one request: `curl -sf -X PUT --data-binary @file.pdf "<upload_url>"`.
4. Check with `get_import({ id })`. Text is extracted and the file is split into sections (by its bookmarks when it has them). With `study: true` cards are generated too, which can take a few minutes for a book. Without it the source has no cards until the reader makes them from the page. Once `imported`, the answer carries an `open:` link to the page in Strata; give that link to the reader.

Use the same `ref` for a file each time you see it. When an HTML, Markdown or text file changes, sending it again under its `ref` replaces its source in place: the same `src_` id, the reader's highlights kept where their words still are, the cards already made left as they are. Same bytes come back as `unchanged`. A changed PDF is added as a new source with "(updated)" in its name, and the old one and its highlights stay.

An `.html` file with its own design (a `<style>`, a stylesheet `<link>`, `<script>`, `<canvas>`, `<svg>` or `<input>`) opens live in the reader on a laptop, where the reader can highlight it; on a phone or iPad, and for bare HTML, it reads as an article. When you write a live page:

- Put its data in the file. The page runs sandboxed and cannot fetch anything, so `fetch`, XHR and loading a CSV or JSON fail.
- Scripts, styles and fonts from a CDN over `https:` load.
- It shows live on a laptop; a phone or iPad reads its text as an article.
- `get_text` returns the page's readable text, not its HTML. Keep the file itself where you made it.
- To keep what the reader does on the page (choices, checkboxes, notes), call `await window.strata.load()` on `DOMContentLoaded` and `window.strata.save(value)` with the whole JSON value (up to 64 KB) after each change; `localStorage` doesn't work there. Revising the page keeps its saved value, and `get_context` on the source shows it. The page should still work when `load()` returns null or `save()` rejects.
- Don't build note boxes for feedback: the reader writes notes on any words, and on any element you give a `data-strata-id` (a decision card, a table row, a diagram's box), e.g. `<section data-strata-id="S3">`. Keep those ids the same across revisions so the notes stay on their boxes.
- When a page has tabs, give each tab button `aria-controls` naming its panel's `id`: the reader's notes on a hidden panel then show on its tab.

The reader's notes on your page reach you as they are written: there are no drafts. `get_context({ id: "<board>/comments", filter: { source: "src_…", state: "with_agent" } })` lists the notes whose last word is the reader's, each with its replies and the file the page came from. Edit that file, upload it again under the same `ref`, then answer under each note with `apply` and `reply_note { id, text }`: say what you changed, or why you didn't. The reader sees your reply at once, in the fold under those words.

For a web page, arXiv abstract or YouTube video (its transcript), use `capture({ board, key, url })` instead. A video can take a minute or two. It also arrives without flashcards unless you pass `study: true`.

Flashcards are the reader's choice. Leave `study` out for your own pages, drafts and explorations; pass `study: true` only when the reader asked for cards from this file. A source without them reads "not studied, no flashcards" in `get_outline` and `get_context`; that is expected, not a failure.

## routine

You are the reader's routine: a Claude session that Strata wakes (a press in Dispatch, or Run now) or that runs on its own schedule, with the reader's connectors (Linear, Slack, GitHub, Notion…) beside this server. The wake text says why it ran; the board says what to do. Each run:

1. **Dispatch.** `dashboard_board`, then for each thread in `implementing`, `dashboard_open`. The reader has one button, Send, so the notes before it say what they want, and you decide what comes next and where the page lands (`lands` on `dashboard_post`). No page yet: write a proposal. Notes asking for changes: revise the page and answer each note in `replies`. Notes that pick an option, or "go": build it and post the built page to `review`. Send on a built page with no objection: merge, then post a finish page. Reopen (Send on a Finish page): read the notes and pick again.
2. **The inbox.** On a scheduled run, look through the connectors for new work meant for the reader and add it with `dashboard_add_items`, after `dashboard_read`, so nothing is added twice.
3. Before stopping, call `dashboard_board` once more: a press made while you worked doesn't wake a second run. Never move or edit a thread yourself: a page's `lands` is the only way you move one.

A wake from Strata names its press and thread ("Send: …", "Reopen: …", "Sent to Dispatch: …"; older ones say "Go: …" or "Send back: …"); a run with no such line is the scheduled one. Build in the repository the thread's links or text name; if none of the routine's repositories fits, say so in the page instead of guessing.

Where a page lands is your call, not a fixed order:

- `decide`: a proposal or a question the reader answers.
- `review`: the whole thing built and ready to merge. A stack of PRs goes once, all of it, not one part at a time.
- `finish`: nothing more to build. Merged, or the decision was not to do it, or it became a Linear issue (link it). The page lists what the reader can now check ("open X, and Y shows"), if anything; the reader archives it from there.

A page is one self-contained, light HTML file, short enough to decide from. Copy the exemplar's layout and styles and change only the content:

- **proposal** (lands in `decide`): the problem, what happens today, the options with the one you would pick, and its size and risk. `get_guide({ topic: "proposal" })`.
- **built** (lands in `review`): what failed before and passes now, what you added or left out, and the PR. `get_guide({ topic: "built" })`.
- **finish** (lands in `finish`): the built page's layout, cut to what happened (merged, filed, or not doing it, with the link) and a short list of checks.

Give each option and claim a stable `data-strata-id`, as the exemplars do, so the reader's notes land on it.
