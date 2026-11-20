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

`add_deck` and `edit_cards` follow `get_guide({ topic: "flashcards" })`, and `add_deck` is refused without the receipt it ends with.

Example:

```json
{ "board": "thesis", "key": "plan-2026-10-17-a", "ops": [
  { "op": "add_group", "name": "RQ2 retrieval vs long context" },
  { "op": "place", "id": "src_7f3a", "group": "RQ2 retrieval vs long context" },
  { "op": "set_group", "id": "RQ2 retrieval vs long context", "by": "2026-12-01" },
  { "op": "append_log", "text": "Grouped the long-context papers under RQ2." }
] }
```

A board is the reader's project: its groups are its units, read in order, and a source in no group is a loose end. `set_project` gives the project an end date, archives it, or stars it (a starred project sorts first for the reader); `set_group` dates a unit. Dates are YYYY-MM-DD.

## flashcards

A deck you add has the shape of one Strata generates, so the reader gets the same concept map, the same order and the same Review page from either. Build it in the generator's order: the tree first, then the cards the tree asks for.

1. **The tree** (`tree` on `add_deck`). `question` is the one question the whole section answers. `nodes` holds exactly one root of kind `synthesis`: its `label` answers that question as a claim, and its `questions` ask for the highest-level takeaways. Under it sit the claims that carry it, with the detail beneath them as `children`. Every node is a claim that makes sense read cold (never a topic heading), has a `kind` (synthesis, concept, mechanism, move, distinction, procedure or boundary), sits `at` a verbatim quote like a card, and lists the `questions` a reader who holds it can answer: one act of recall each, answerable in the head, never a list or a derivation. `glossary` is the vocabulary the tree leans on, in dependency order, each with a short `kernel`. Cover the section from start to end, in proportion; how deep the tree goes and how many questions it asks is your judgement of the material.
2. **The cards.** One definition card per glossary term (`introduces: "<term>"`, a front that asks for the term and nothing else), then one card per question. Each card names its `node` (`n1` is the root, `n1.2` its second child, `n1.2.1` that child's first) and lists in `asks` the questions it answers (`n1.2#1` is the first question of `n1.2`; each question is answered by one card). `uses` lists the glossary terms its faces lean on. A back is the answer, not a lesson. Definition cards are put first for you, in the glossary's order.

`add_deck` refuses a deck that doesn't fit: no synthesis root, a card on a node the tree lacks, a question no card answers, a term no card introduces. A section that already has a tree (`get_context` on it shows the tree) takes new cards without `tree`; send `tree` to replace it.

```json
{ "op": "add_deck", "guide": "<the receipt below>", "section": "sec_4c1d",
  "tree": { "question": "What does a DV01-neutral hedge leave exposed?",
    "glossary": [{ "term": "DV01", "kernel": "The price change for a one basis point move in yield." }],
    "nodes": [{ "label": "A DV01-neutral hedge covers small parallel shifts and fails on convexity", "kind": "synthesis",
      "at": "A DV01-neutral hedge protects only against small", "questions": ["What does a DV01-neutral hedge protect against?"],
      "children": [{ "label": "Convexity is where the hedge fails", "kind": "boundary", "at": "Convexity is the failure mode", "questions": ["Where does a DV01-neutral hedge fail?"] }] }] },
  "cards": [
    { "front": "What is DV01?", "back": "The price change for a one basis point move in yield.", "at": "DV01-neutral hedge protects only", "node": "n1", "introduces": "DV01" },
    { "front": "What does a DV01-neutral hedge protect against?", "back": "Small, parallel shifts in the curve.", "at": "protects only against small, parallel shifts", "node": "n1", "asks": ["n1#1"], "uses": ["DV01"] },
    { "front": "Where does a DV01-neutral hedge fail?", "back": "On convexity: large moves.", "at": "Convexity is the failure mode", "node": "n1.1", "asks": ["n1.1#1"], "uses": ["DV01"] }
  ] }
```

A card, a tree node and a glossary term each sit at a verbatim quote of the words they are about (`at`), and nowhere else: 4 to 40 consecutive words copied exactly from its source, that occur once in its passage (on one page, for a PDF). `add_deck` and `edit_cards` compile every quote before anything is written; one that doesn't compile is an error naming why (not verbatim, occurs twice, outside the passage, too short), and the batch writes nothing, so fix what it names and send it again. A deck's or a card's context shows each card's place and whether it compiles; `get_text` on its section gives the words to quote. `edit_cards` moves a card or rewrites its faces in place: its id, reviews and keep stay.

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

1. **Dispatch.** `dashboard_board`, then for each thread in `implementing`, `dashboard_open`. The reader has one button, Send, so the notes before it say what they want, and you decide what comes next and where the page lands (`lands` on `dashboard_post`). No page yet: write a proposal. Notes asking for changes: revise the page and answer each note in `replies`. Notes that pick an option, or "go": build it and post the built page to `review`. Send on a built page with no objection: merge, then post a finish page. Reopen (Send on a Finish page): read the notes and pick again. Every page goes with `ask` and `heard`, shown side by side above it: the reader's ask as it stands now, in your own words and folding in what their notes changed, and how you read it. When a note raises an idea that is its own piece of work, file it with `splits` on `dashboard_post` (a new To-do thread linked to this one) instead of widening the thread, and say so in the reply.
2. **The inbox.** On a scheduled run, look through the connectors for new work meant for the reader and add it with `dashboard_add_items`, after `dashboard_read`, so nothing is added twice. Skip anything its **Handled in the last 7 days** section lists: the reader already dealt with it.
3. **Primers.** `whoami` lists the primers the reader asked for under **Primers asked for** (a wake that says `Primer: src_…` is one of them). Draw each, as `get_guide({ topic: "primer" })` says.
4. Before stopping, call `dashboard_board` once more: a press made while you worked doesn't wake a second run. Never move or edit a thread yourself: a page's `lands` is the only way you move one.

A wake from Strata names its press and thread ("Send: …", "Reopen: …", "Sent to Dispatch: …"; older ones say "Go: …" or "Send back: …"); a run with no such line is the scheduled one. Build in the repository the thread's links or text name; if none of the routine's repositories fits, say so in the page instead of guessing.

Where a page lands is your call, not a fixed order:

- `decide`: a proposal or a question the reader answers.
- `review`: the whole thing built and ready to merge. A stack of PRs goes once, all of it, not one part at a time.
- `finish`: nothing more to build. Merged, or the decision was not to do it, or it became a Linear issue (link it). The page lists what the reader can now check ("open X, and Y shows"), if anything; the reader archives it from there.

A page is one self-contained, light HTML file, short enough to decide from. You are a better designer than any template, so there is none: shape each page to the task in front of you. These are the few things that hold every time.

- **proposal** (lands in `decide`): two or three options and the one you would pick. `get_guide({ topic: "proposal" })`.
- **built** (lands in `review`): what works now, how you know, and the PR. `get_guide({ topic: "built" })`.
- **finish** (lands in `finish`): what happened, with the link, and anything the reader can now check.

**The reader's attention is the scarce thing.** Readers scan before they read: on a web page most people read about a fifth of the words, and look hardest at the top and down the left edge. So put the answer in the first line, order the rest by importance, and fold away whatever a reader only needs if they doubt the answer. A person holds about four things in mind at once, so group content into a few named chunks and put the things to compare side by side instead of asking anyone to remember one screen while looking at another. Colour, position, size and shape are seen before a word is read, so give each one a single meaning and use it to mark the one thing that needs attention. Every mark, word and box must carry something the reader needs: label things directly, drop decoration and repetition, and let people recognise what they see instead of decoding it.

**What the reader likes to see.** Before and after, side by side. Pseudocode as the abstraction of a code change, rather than the diff. A mock of the screen when the change is visual, designed in Figma when that helps (link the frame, and draw the gist inline). Beyond that, use your judgment.

Give each option and claim a stable `data-strata-id`, so the reader's notes land on it.

## primer

A primer is the first layer of a source: one page the reader opens before page 1, to know what they are about to read. What are the threads to follow, what matters, what does it find? It is not a text summary. Use what a page can do that prose can't: space, colour, pictures, a slider where moving one helps. How it looks is your call, source by source. A paper, a textbook chapter and a podcast each want a different page. Read the whole source first (`get_context` on it, then `get_text`), along with its concept tree and the reader's highlights if it has them.

Draw it in two stages, as a deck is drawn from its concept tree. First the **plan**: the one question the source answers, the threads a reader follows through it (in reading order, each with a gist and where it is), the main results as claims that read cold, and what to keep track of (terms, notation, assumptions). Then the page, drawn from the plan. The plan goes with the page to `set_primer`, and the reader can open it beside the page (`i`), so it should agree with what the page shows.

The few things that hold every time:

- One self-contained HTML file: inline CSS and JS, scripts and fonts only from https CDNs, no `fetch`, no `localStorage`. Light only. It is read beside the source, so it should work in a narrow column (about 420px) as well as wide.
- Every number and claim comes from the source. Say where it is (a page, a timestamp) so the reader can go there.
- Give each part a stable `data-strata-id`, so the reader's notes land on it.

To deliver it: `request_upload` the page to the source's board, named `Primer · <source title>.html`, with `origin: { from: "primer", ref: "primer/<src_ id>" }` (the same ref replaces the page in place on a redraw). When `get_import` says it is done, `apply` `set_primer { guide, source, primer, plan }`, with `guide` the receipt at the end of this guide. That links the two, so the source shows a Primer button and the request is cleared. A redraw (the source already has a primer) is answered the same way. Read the reader's notes on the old page (`<board>/comments`) first, and answer them with `reply_note`.

An agent that uploads a source may draw its primer too, the same way, without being asked.

## proposal

A proposal lands in `decide`. It always offers two or three real options and says which one you would pick and why; that is what makes it quick to answer. Everything else (how you show the problem, what you compare, how long it is) follows from the task.

## built

A built page lands in `review`. It says what works now and how you know (what was red and is green, which checks ran, what you could not run), what you left out, and which PRs Send merges. Show the change the way the task is about it. Everything else follows from the task.
