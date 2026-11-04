# FIGMA.md — product screens in Figma

> **Not part of ordinary feature work.** Agents building or changing features should ignore
> this file and the Figma file: don't update either, and don't treat them as a source of
> truth. The code is the truth. The Figma file is updated only when someone asks, and exists
> to look at and discuss the product.

**File:** a Figma file named Strata, kept by the maintainer and shared on request. Fixture data
only: everything in it comes from the preview room's seed.

## Why this exists

1. **A second view of the product.** Every screen in one place, so we can see what exists,
   what's missing and what's inconsistent without reading code.
2. **Feedback before we build.** Try screens and flows in Figma and collect opinions before
   writing the frontend.

## How the file is organised

| Page                                | What it holds                                                 | Who changes it                       |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| Cover                               | Purpose, legend, sync stamp (commit + date), findings, gaps   | Every update                         |
| Foundations                         | Colour tokens (variables), text styles, shared components     | When tokens or shared pieces change  |
| **As built ·** one page per surface | Screens as the code renders them today                        | Only by an update from the code      |
| **Proposed ·** one page per surface | Screens we plan to build or redesign                          | People, by hand or by asking Claude  |

The dashboard has its own As built page: it is a separate app the
room only hosts (`public/dashboard.html`, `server/features/dashboard`). An update rewrites As
built pages and Foundations, never a Proposed page.

On an As built page:

- One **section per route** (`/?board=[id]`, `/dashboard`, …).
- Frames are named _route — state_, and phone frames end in ` · phone`:
  `/?view=review — revealed · phone`. Desktop frames sit in one row, phone frames in the row
  below.
- Above each frame sits a yellow **Note**: the tag, a few bullets on what a user would
  stumble on, and a `Data:` line saying what fixture data it shows.

## What gets a frame

One frame per **screen and state**, where the state changes what the user can do or read:
empty vs. populated, a card before and after it is revealed, a dialog open. Desktop is
1440 × 900; phone is 390 × 844 and only for screens built for a phone (`web/styles/phone.css`
and the `PHONE` branches in `web/`): library, board, review, cram and the dashboard.
The reader and the keeps have no phone layout, so they have no phone frames; the Cover lists
that as a finding.

Each note starts with its tag:

- **As built · captured**: imported from the running preview room.
- **As built · from code (_files_)**: a state the preview room can't reach, rebuilt from the
  source files named in brackets.
- **Proposed**: doesn't exist yet.

Frames are editable layers (text, boxes, vectors). Only what isn't Strata's own UI arrives as
an image: a PDF page, and a live HTML page's iframe.

## How to update ("Claude, go update")

1. Read this file and the Cover's sync stamp.
2. List every file changed since that commit (`git diff --stat <stamp>..HEAD`), not just
   `web/surfaces`: what a frame shows also comes from `web/capabilities`, `web/shell`,
   `web/styles` and each surface's CSS, the server's answers (`server/features`),
   `public/dashboard.html`, and the seed (`tools/demo-seed.mjs`). Map each changed file to
   frames, or rule it out.
3. Run `npm run figma:capture` (needs `npx playwright install chromium`). It builds, serves a
   fresh seeded preview room, walks every surface through its states, and writes to
   `data/figma/` (git-ignored):
   - `desktop/<surface>--<state>.png|html` and `phone/…`: a reference screenshot and a
     self-contained HTML snapshot per state;
   - `foundations.html` (one `.component` per shared piece) and `tokens.json`.

   `--only review,cram` captures some surfaces; `--only foundations` only Foundations. A new
   state is a step in `surfaceSteps` in `tools/figma/capture.mjs`.
4. Import each affected snapshot with the Figma MCP's `html_to_figma`, under its route's
   section, then rename and position it and rewrite its note. `foundations.html` imports with
   `cssSelector: ".component"`, one frame per piece; make each a component. Replace frames,
   don't stack them, and flag frames whose route or state is gone.
5. Update the Cover: the pages list, the findings, and the gaps. Move the sync stamp only once
   every changed file from step 2 is mapped or ruled out.

Work in vertical slices: one surface end to end, then the next.

## How the snapshots work

`tools/figma/snapshot.mjs` writes each element's computed style inline, so the import doesn't
depend on Figma's viewport, media queries or `zoom` (the room draws at 1.4× on desktop; the
snapshot bakes that into pixel lengths). Fonts are embedded, canvases and iframes become
images, open dialogs become plain boxes above the page, and a one-line label is kept on one
line, because Figma's copy of a font runs a hair wider. After import, a label Figma still cuts
short by a few percent can be untruncated in Figma.

## Known gaps

- The sign-in page: the preview room runs open (`STRATA_OPEN=1`).
- States the capture doesn't walk yet: the offline banner, the import and section editor, the
  card editor and history, find, a PDF book page parted by a fold, and a card being turned in
  its fold.
