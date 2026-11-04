@AGENTS.md

## Explorations

A design, prototype or explainer you make for Strata is one self-contained `.html` file (inline CSS and
JS; scripts and fonts only from https CDNs; no `fetch`, no `localStorage`), uploaded with the `strata`
MCP server's `request_upload` to the board with the handle `explorations` (`create_board` it if
`whoami` lists none). Strata is light-only, so design the page for light, with no dark-mode styles. Reuse the `ref` when you revise a file: the upload replaces the page in place.
Leave `study` out, so it arrives without flashcards; the reader makes them from the page if they want them. Publish an artifact only when it is meant
for someone else, and link it from the source. If the `strata` server is not connected, say so and leave
the file in your scratchpad; don't commit it.
An interactive page keeps its state with `window.strata.load()`/`save()` (see the `uploads` guide), never `localStorage`.
Don't build note boxes for feedback: give each thing the reader may write a note on a stable `data-strata-id`, read their notes from `<board>/comments`, and answer under each with `reply_note`.
