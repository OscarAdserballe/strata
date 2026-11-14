import type { DatabaseSync } from 'node:sqlite';
import { importTransitions } from '../../../shared/imports/import-status.ts';

export function ensureImports(db: DatabaseSync): void {
  const states = Object.keys(importTransitions).map(s => `'${s}'`).join(',');
  const edges = Object.entries(importTransitions).flatMap(([from, tos]) => tos.map(to => `(OLD.stage='${from}' AND NEW.stage='${to}')`)).join(' OR ');
  db.exec(`CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, filename TEXT NOT NULL,
    size INTEGER NOT NULL CHECK(size>0), received INTEGER NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=size),
    stage TEXT NOT NULL DEFAULT 'uploading' CHECK(stage IN (${states})),
    error TEXT, page INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
    prepared TEXT, plan TEXT, resource_id TEXT UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, study INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK(stage IN ('uploading','cancelled') OR received=size),
    CHECK(stage NOT IN ('sizing','awaiting_groups','queued','finalizing') OR prepared IS NOT NULL),
    CHECK((stage='imported')=(resource_id IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS imports_stage ON imports(stage,created_at);
  CREATE TABLE IF NOT EXISTS import_chunks (
    import_id TEXT NOT NULL REFERENCES imports(id), offset INTEGER NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY(import_id,offset)
  );
  CREATE TRIGGER IF NOT EXISTS import_transition BEFORE UPDATE OF stage ON imports
    WHEN OLD.stage<>NEW.stage AND NOT (${edges})
    BEGIN SELECT RAISE(ABORT,'invalid import transition'); END;
  CREATE TRIGGER IF NOT EXISTS import_complete_bytes BEFORE UPDATE OF stage ON imports
    WHEN NEW.stage='stored' AND NEW.received<>NEW.size
    BEGIN SELECT RAISE(ABORT,'incomplete upload'); END;`);
}

// last_page = 0 means to the end: the server has no PDF parser to know where a section stops.
export const SECTION_TO_END = 0;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT, created_at INTEGER NOT NULL
);
-- archived: the turn was CLEARED — off the screen and out of the model's context, but not
-- out of the record. Clearing manages the context window; it is not a shredder.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, board_id TEXT NOT NULL, role TEXT, text TEXT,
  calls TEXT, node_ids TEXT, idx INTEGER, created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS card_messages (
  course TEXT NOT NULL, card TEXT NOT NULL, idx INTEGER NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(course, card, idx)
);
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS review_receipts (
  id TEXT PRIMARY KEY, card TEXT NOT NULL, course TEXT NOT NULL,
  got INTEGER NOT NULL, at INTEGER NOT NULL
);
-- legacy: a single board-wide deck binding, superseded by pairs (kept so old DBs open)
CREATE TABLE IF NOT EXISTS board_prefs (
  board_id TEXT PRIMARY KEY, deck TEXT
);
-- A BOARD IS A COURSE, and it holds an ordered list of PAIRS. A pair couples one source
-- to one deck — "lecture 4: the slides + the cards" — and opening it switches both at once.
-- Either side may be null: a deck with no slides is a blank page you drill against; a
-- source with no deck is just reading. This is the unit you navigate within a board.
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT NOT NULL, board_id TEXT NOT NULL, label TEXT,
  resource_id TEXT, deck TEXT, ord INTEGER NOT NULL DEFAULT 0,
  section_id TEXT,                        -- the SECTION this pair opens (see below)
  PRIMARY KEY (board_id, id)
);
CREATE INDEX IF NOT EXISTS idx_pairs_board ON pairs(board_id, ord);
-- A SECTION is an AUTHOR-GIVEN division inside a source: a run of its pages, named by
-- whoever wrote it. A book's chapters, taken from the PDF's own bookmarks. Nothing here
-- ever invents a boundary — a source whose author gave none is exactly ONE section
-- spanning the whole thing, which is why every source that existed before this table
-- carries on behaving exactly as it did (rule 1).
--
-- A section is DERIVED, NOT OWNED (rule 2): you do not create, move or delete one. It
-- lives and dies with its source, which is why pairs.section_id is the thing that was
-- added and pairs.resource_id stayed — a pair still knows its source directly, so every
-- existing read path keeps working, and a chapter can never wander off without its book.
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, board_id TEXT NOT NULL,
  ord INTEGER NOT NULL, label TEXT NOT NULL,
  first_page INTEGER NOT NULL, last_page INTEGER NOT NULL,   -- 1-based, inclusive, PHYSICAL sheets
  created_at INTEGER NOT NULL,
  -- work | apparatus: is this the book, or what the book is bound with? Decided once, by
  -- one small model call over the labels (distil.ts ⓪). Apparatus stays navigable and
  -- keeps its pair — it simply never gets a tree or a deck. Null until that call lands.
  kind TEXT,
  -- what THIS SECTION costs in the model's context. A chapter is what rides a turn, so a
  -- chapter is what the meter has to report — the whole book's figure, repeated on every
  -- chapter row, is off by the number of chapters.
  tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sections_resource ON sections(resource_id, ord);
-- every board opens on its HOME PAGE: a running log in markdown, always page one, always
-- there. It is not a pair (it has no source and no deck) — it is where the board thinks.
CREATE TABLE IF NOT EXISTS board_notes (
  board_id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT "", updated_at INTEGER NOT NULL
);
-- a live page's own state: the one JSON value the page saved with window.strata.save.
CREATE TABLE IF NOT EXISTS page_states (
  resource_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_page_states_board ON page_states(board_id);
-- a board's RESOURCE SET (0..N): the files it's reading. A board = one context window: the
-- resources + chat are what the model sees at once, so there is no retrieval — every resource's
-- text/bytes rides each turn, bounded by the budget (BUDGET_TOKENS). text is md/txt; a PDF's
-- bytes live NEXT DOOR, in resource_blobs.
--
-- THIS TABLE IS READ ON EVERY BOARD ACTION AND MUST STAY NARROW. It is what the board state,
-- the budget meter and the boards list are built from, and none of them want a byte of the
-- file — they want a filename and a token count. The bytes used to live here, in a "data"
-- column holding base64, and the cost was not subtle: seventeen sources on one board came to
-- 63 MB of it, SELECT * took 550ms, boardState ran it twice, and node:sqlite is synchronous
-- — so every highlight and every board open stopped the whole server for a second while it
-- loaded PDFs nobody had asked for. Splitting the bytes out took that query to 0.1ms.
CREATE TABLE IF NOT EXISTS resources (
  id TEXT NOT NULL, board_id TEXT NOT NULL, filename TEXT, mime TEXT, text TEXT,
  created_at INTEGER NOT NULL,
  tokens INTEGER,                         -- exact token count (Gemini countTokens), null → heuristic
  included INTEGER NOT NULL DEFAULT 1,    -- whether this resource is fed to the model (manual context selection)
  kind TEXT,                              -- pdf | text | transcript — STORED, not sniffed
  origin_url TEXT,                        -- where it was captured from; null for uploads
  bytes_len INTEGER,                      -- length of the blob next door, so the token heuristic needn't load it
  done_at INTEGER,                        -- "I am through with this" — said by hand (the desk's verb), null = not said
  PRIMARY KEY (board_id, id)
);
CREATE INDEX IF NOT EXISTS idx_resources_board ON resources(board_id);
-- THE BYTES, kept apart from the metadata that has to be cheap. One row per resource that has
-- any: a PDF's file, and the per-page text the client extracted on the way in (JSON string[],
-- index 0 = page 1) so a SECTION can be shown to the model on its own — see sectionSource().
-- Fetched only by the two paths that genuinely want the file: /raw, and building model context.
--
-- The bytes column is a real BLOB, not base64. The wire and the model both want base64, but
-- storing it that way made the row a third larger and put a decode on every read of it.
CREATE TABLE IF NOT EXISTS resource_blobs (
  resource_id TEXT PRIMARY KEY,
  bytes BLOB,
  page_text TEXT
);
-- IMAGES: a screenshot pasted into the Ask or onto a card face (features/images). The id is
-- the first 16 hex of the bytes' SHA-256, so the same picture is one row however often it is
-- pasted, and a row never changes. Text refers to it as ![alt](img:<id>) (shared/images/ref.ts);
-- no board, because a card or a message on any board may show it. The bytes are read by one
-- route (GET /api/images/:id, cached for good on the device) and by the chat turn that sends
-- them to the model — never by a board's read.
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
  size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_board ON messages(board_id);
-- the decks: a course is a slug + ordered cards, loaded from courses/*.json on boot
CREATE TABLE IF NOT EXISTS courses (
  slug TEXT PRIMARY KEY, title TEXT NOT NULL, meta TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, course TEXT NOT NULL, deck TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, ord INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_course ON cards(course, ord);
-- A DROPPED CARD, remembered. Deleting a row from cards is not enough: loadCourses()
-- rewrites every committed course on boot, and installDeck() rewrites a generated deck on
-- every re-distil — either would quietly resurrect a plain delete. So a drop is a
-- TOMBSTONE, re-applied after each bulk rewrite (applyDrops). Card ids are content-derived
-- (course/type/slugified-front), so the same card rebuilt gets the same id and stays
-- dropped; a card whose front the model rewrote is a different card and comes back, which
-- is right. The full row rides along so a drop is reversible (the restore route).
CREATE TABLE IF NOT EXISTS card_drops (
  id TEXT PRIMARY KEY, course TEXT NOT NULL, deck TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, ord INTEGER NOT NULL, created_at INTEGER NOT NULL
);
-- A CARD YOU REWROTE, remembered. The same problem the tombstone next door solves, and
-- the same answer: writing a corrected face straight into the cards table holds only until the
-- next bulk rewrite — boot's loadCourses() re-imports every committed course, a re-distil's
-- installDeck() rebuilds a generated deck — and the sentence you fixed would quietly come
-- back in the model's words. So an edit is a PATCH, kept beside the deck and re-applied
-- after each of those rewrites (applyEdits), which makes YOUR wording the thing that
-- survives a re-distil rather than the thing it costs.
--
-- Only the faces are patchable (the whitelist per type lives in the route), and the patch
-- is shallow-merged over the payload, so a re-distil's improvements to everything you did
-- not touch still land. Card ids are content-derived, so a card whose front the model
-- rewrote is a different card and arrives unpatched — right, for the same reason a drop
-- does not follow it.
CREATE TABLE IF NOT EXISTS card_edits (
  id TEXT PRIMARY KEY, course TEXT NOT NULL,
  patch TEXT NOT NULL,                   -- JSON: the faces you rewrote, and nothing else
  updated_at INTEGER NOT NULL
);
-- A CARD YOU CHOSE TO KEEP. Grading enrols nothing (features/review/ladder.ts owns that
-- contract): drilling a deck is PROCESSING — a forcing function for understanding a
-- text — and the review ladder only owes RETENTION, the small set actually worth
-- holding in a year. This table is that set, and choosing it — the workbench — is
-- the feature, not overhead.
--
-- Same doctrine as the drop and the edit next door, and it comes for free: the set is
-- keyed by content-derived id and joined at read time, so a bulk rewrite (boot's
-- loadCourses, a re-distil's installDeck) cannot touch it and no re-apply pass exists.
-- A card whose front the model rewrote is a different card and arrives unkept — right,
-- for the same reason a drop does not follow it; a stale id simply never matches a live
-- card again. course and deck ride along so the bench can read one deck's set without
-- joining the cards table.
CREATE TABLE IF NOT EXISTS card_keeps (
  id TEXT PRIMARY KEY,          -- the card's content-derived id
  course TEXT NOT NULL,
  deck TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- the register's fortnight of keeps (features/register/repo.ts keptSince), read on every
-- open of home: found by date through this index, already in order, rather than by a scan
-- of every keep and a sort. course rides along so the read never visits the table.
-- test/integration/statements.test.ts holds the plan to it.
CREATE INDEX IF NOT EXISTS idx_card_keeps_created ON card_keeps(created_at, course);
-- the CONCEPT TREE: the structure a deck is grown from, and the artifact you read (and
-- later correct) when the deck is wrong. One per SECTION — which for the ordinary source
-- with no author-given divisions is still one per source, exactly as before. Distilling a
-- 600-page book in one call produces a dozen chrome nodes; distilling it a chapter at a
-- time produces calls the size the prompt was actually written for.
CREATE TABLE IF NOT EXISTS trees (
  section_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, board_id TEXT NOT NULL,
  title TEXT, question TEXT,
  json TEXT, ascii TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  cards INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trees_resource ON trees(resource_id);
-- A MARK is a passage you highlighted, with an optional note. It is the one thing in this
-- database that you author directly and that no pipeline can regenerate — which is exactly
-- why it is a table and not a column on something else: a section is one derived row per
-- bookmark, a mark is 0..N authored things with a position inside one.
--
-- WHERE it points is one shape for all three kinds, and that is the whole trick: a character
-- range in THE SAME TEXT THE MODEL READS. For a PDF that is the page's extracted text, and
-- the page column says which page; for markdown and a transcript it is the source text
-- itself and the page column is null. So there is no per-kind anchor object — the kind only
-- decides whether the offsets are page-relative.
--
-- The QUOTE is the authority, not the offsets. Offsets are a hint that makes re-finding
-- cheap; if the text under them has moved, the quote is searched for instead. A mark that
-- can only be found by arithmetic is a mark that a re-extraction can silently relocate.
--
-- RECTS are paint, and PDF-only: the selection's boxes as FRACTIONS of the page (0..1), so
-- they are applied as percentages and no zoom, canvas scale or window size can shift them.
-- Stored at creation because painting must not need the page's text layer: a page repaints
-- its marks from these the moment it draws, without a second trip through pdf.js.
CREATE TABLE IF NOT EXISTS marks (
  id TEXT NOT NULL, board_id TEXT NOT NULL, resource_id TEXT NOT NULL,
  page INTEGER,                                  -- pdf: the physical sheet. null for prose.
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,
  quote TEXT NOT NULL,
  note TEXT,                                     -- your sentence. null = highlighted, unsaid.
  rects TEXT,                                    -- pdf: JSON [[x,y,w,h],…] in page fractions
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, id)
);
CREATE INDEX IF NOT EXISTS idx_marks_resource ON marks(resource_id, page);
-- what is said under a note: by you, or by an agent answering it. Sent as written: there are no drafts.
CREATE TABLE IF NOT EXISTS mark_replies (
  id TEXT NOT NULL, board_id TEXT NOT NULL, mark_id TEXT NOT NULL, resource_id TEXT NOT NULL,
  author TEXT NOT NULL,                          -- you | agent
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, id)
);
CREATE INDEX IF NOT EXISTS idx_mark_replies_mark ON mark_replies(board_id, mark_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mark_replies_resource ON mark_replies(resource_id);
-- the words a question was asked at: its turns are messages of the source's thread that name it (messages.ask_id)
CREATE TABLE IF NOT EXISTS asks (
  id TEXT NOT NULL, board_id TEXT NOT NULL, resource_id TEXT NOT NULL,
  page INTEGER, start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,
  quote TEXT NOT NULL, rects TEXT, box TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, id)
);
CREATE INDEX IF NOT EXISTS idx_asks_resource ON asks(resource_id);
-- a multi-section source's own tree: its sections' trees, merged by one cheap reduce call
-- that reads the chapter trees and never re-reads the book. A single-section source has no
-- row here — its one section tree already IS the source's tree.
CREATE TABLE IF NOT EXISTS source_trees (
  resource_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT, question TEXT,
  json TEXT, ascii TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  updated_at INTEGER NOT NULL
);
-- A question you asked, on its way to becoming a card you hold (see mint.ts). It is ONE
-- row in two states: "open" is a front with no back — the hole, recorded — and "closed" is
-- that same row once you have put your OWN sentence on it. The back is never the model's;
-- that is the invariant the whole thing exists to hold, which is why "back" is written only
-- by the mint routes and never by a distil.
--   variant   which gate this card was made to pass — a card remembers what it cost
--   opens_at  when the back may first be written (the "cold" gate; 0 = now)
--   meta      the gate's own workings: the guess, the banned list, whether you peeked, the
--             first of two passes, the atoms you missed. One JSON column, because every gate
--             wants a different shape and none of them wants a table.
CREATE TABLE IF NOT EXISTS minted (
  id TEXT NOT NULL, board_id TEXT NOT NULL, pair_id TEXT,
  variant TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
  front TEXT NOT NULL, back TEXT,
  source TEXT,                                   -- where it came up, in a card's own words
  meta TEXT,
  opens_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, id)
);
CREATE INDEX IF NOT EXISTS idx_minted_board ON minted(board_id, state);
-- FEEDBACK: a note left on the exact thing that was slightly off — a card face, a chat
-- reply — pressed in place, while it was on screen. Each row carries a SNAPSHOT of that
-- thing (context, JSON), so acting on the note never needs the session that produced it:
-- the card's whole payload, or the question and the reply it drew. "resolved" is for the
-- iteration loop — a note that has been folded into a prompt or a deck gets marked, not
-- deleted, because the record of what kept going wrong is itself the useful artifact.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  board_id TEXT,
  kind TEXT NOT NULL,                    -- chat | card | general
  card_id TEXT, deck TEXT,               -- card: which card, in which deck
  message_idx INTEGER,                   -- chat: the turn's idx in its board's thread
  context TEXT,                          -- JSON snapshot of the thing commented on
  comment TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- THE PLAN: what a board is FOR, and how its rail is arranged toward that. One free-text
-- purpose (boards.purpose, added by migration), the groups you made, the milestones you named,
-- and — per rail item — a PLACE: which group it sits in, which milestone it counts toward,
-- whether it is pinned, and where it falls inside its group.
--
-- An ITEM is a rail entry: a resource id for a source, a pair id for a deck-only pair. The
-- places are their OWN table, not columns on resources, for two reasons: a deck-only pair
-- has no resources row to hang them on, and the resources table is covered by an index
-- that must not grow (see its note above). An item with no row here is simply ungrouped,
-- unpinned and owed to no milestone — which is why nothing was ever backfilled.
CREATE TABLE IF NOT EXISTS board_groups (
  id TEXT NOT NULL, board_id TEXT NOT NULL, name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, id)
);
-- due is FREE TEXT ("before the exam", "12 Oct"): a milestone is a promise to yourself,
-- and nothing here schedules anything off it. done_at null = not reached.
CREATE TABLE IF NOT EXISTS board_milestones (
  id TEXT NOT NULL, board_id TEXT NOT NULL, name TEXT NOT NULL,
  due TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', done_at INTEGER,
  ord INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, id)
);
-- AGENT TOKENS: what lets Claude Code or Codex reach this room over MCP (features/agent). Only the
-- SHA-256 of a token is kept; the token itself is shown once, when it is made.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,                   -- "read" or "read write"
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS board_places (
  board_id TEXT NOT NULL, item TEXT NOT NULL,
  group_id TEXT,                          -- null = ungrouped
  milestone_id TEXT,                      -- null = counts toward none
  pinned INTEGER NOT NULL DEFAULT 0,
  ord INTEGER,                            -- position inside its group; null = never placed
  PRIMARY KEY (board_id, item)
);
-- THE DASHBOARD (features/dashboard): a separate app the room only hosts, so nothing here has a
-- board_id. A task is like a Linear issue: a body, dated updates appended to it, one level of
-- subtasks. Agents never touch tasks directly; they add inbox items, and you keep or drop each.
CREATE TABLE IF NOT EXISTS dashboard_tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,                    -- you | claude | waiting | later | done | dropped
  waiting_on TEXT, parent_id TEXT,        -- parent: one level only, checked on write
  links TEXT NOT NULL DEFAULT '[]',       -- JSON [{ kind, ref, title?, url? }]
  prompt TEXT,                            -- your edited prompt; null = built from the task
  created_from TEXT,                      -- JSON { source, url?, quote? }
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  pinned_at INTEGER,                      -- set: on Today
  area TEXT,                              -- work | personal: which board it shows on
  cleared_at INTEGER,                     -- set: off the board, in the archive; never deleted
  stage TEXT,                             -- backlog | todo | thinking | decide | implementing | review | done | dropped; state mirrors it
  morning_at INTEGER                      -- set: picked for tomorrow morning (pinned_at mirrors it)
);
CREATE INDEX IF NOT EXISTS idx_dashboard_tasks_parent ON dashboard_tasks(parent_id);
CREATE TABLE IF NOT EXISTS dashboard_updates (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, at INTEGER NOT NULL,
  text TEXT NOT NULL, from_json TEXT, links TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_dashboard_updates_task ON dashboard_updates(task_id, at);
-- An inbox item waits until you keep or drop it; outcome says which, result_id what keeping made.
CREATE TABLE IF NOT EXISTS dashboard_inbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, -- task | subtask | update | fragment
  item TEXT NOT NULL,                     -- JSON: the item as it was added
  at INTEGER NOT NULL, handled_at INTEGER, outcome TEXT, result_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_dashboard_inbox_open ON dashboard_inbox(handled_at, at);
-- What agents say about each place they drafted from, keyed by the item's from.source.
CREATE TABLE IF NOT EXISTS dashboard_sources (
  source TEXT PRIMARY KEY, url TEXT,
  coverage TEXT NOT NULL,                 -- full | partial
  note TEXT, updated_at INTEGER NOT NULL
);
-- The research routine Run now wakes: its fire URL and token (never sent back), and how the last run went.
CREATE TABLE IF NOT EXISTS dashboard_routine (
  id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL, token TEXT NOT NULL,
  ran_at INTEGER, session_url TEXT, error TEXT, updated_at INTEGER NOT NULL
);
-- Dispatch: every page Claude posted on a thread, kept. Each is an HTML source on the board with the
-- dispatch handle, so the reader opens it and the reader's notes on it are that version's notes.
CREATE TABLE IF NOT EXISTS dashboard_versions (
  task_id TEXT NOT NULL, n INTEGER NOT NULL, resource_id TEXT NOT NULL,
  landed TEXT NOT NULL,                   -- decide | review | done: where posting it put the thread
  at INTEGER NOT NULL, PRIMARY KEY (task_id, n)
);
-- Sending a thread, Go and Send back. The newest press on a thread decides where its next page lands.
CREATE TABLE IF NOT EXISTS dashboard_presses (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- send | go | back
  stage TEXT NOT NULL,                    -- where it was pressed: backlog | todo | decide | review
  version INTEGER,                        -- the version it was pressed on; null for send
  at INTEGER NOT NULL, session_url TEXT   -- the routine session it woke, or the one already running
);
CREATE INDEX IF NOT EXISTS idx_dashboard_presses_task ON dashboard_presses(task_id, at);
-- The scratch pad: one free-text document, written whole, so it carries a rev for If-Match.
CREATE TABLE IF NOT EXISTS dashboard_pad (
  id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;
