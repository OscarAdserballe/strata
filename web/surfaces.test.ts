import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ASK_THREADS, BOARD_ACTIONS, CARD_VERBS, LIVE, PENDING, ROUTES, SOURCE_VERBS, SPEC_FIELDS, SURFACES, type Route } from "./surfaces.ts";

const fields = new Set<string>(SPEC_FIELDS);

test("every screen has exactly one entry, keyed by its own route", () => {
  assert.deepEqual(Object.keys(SURFACES).sort(), [...ROUTES].sort());
  for (const [key, spec] of Object.entries(SURFACES)) assert.equal(spec.route, key);
});

test("every screen lists only known capabilities", () => {
  for (const spec of Object.values(SURFACES)) {
    for (const field of Object.keys(spec)) assert.ok(fields.has(field), `${spec.route}: unknown capability ${field}`);
    assert.ok((ASK_THREADS as readonly string[]).includes(spec.ask), `${spec.route}: unknown thread ${spec.ask}`);
    for (const v of spec.card) assert.ok((CARD_VERBS as readonly string[]).includes(v), `${spec.route}: unknown card verb ${v}`);
    for (const v of spec.sources) assert.ok((SOURCE_VERBS as readonly string[]).includes(v), `${spec.route}: unknown source verb ${v}`);
    for (const v of spec.boardActions ?? []) assert.ok((BOARD_ACTIONS as readonly string[]).includes(v), `${spec.route}: unknown board action ${v}`);
    assert.equal(new Set(spec.card).size, spec.card.length, `${spec.route}: a card verb listed twice`);
    assert.equal(new Set(spec.sources).size, spec.sources.length, `${spec.route}: a source verb listed twice`);
    assert.ok(spec.keys.length > 0, `${spec.route}: no key layout`);
  }
});

test("the table declares sources and boards as planned: add a source wherever you read, import progress everywhere but the cram and keeps, a board renamed or deleted from the library and its own page", () => {
  const where = (pred: (s: (typeof SURFACES)[keyof typeof SURFACES]) => boolean) => ROUTES.filter((r) => pred(SURFACES[r]));
  assert.deepEqual(where((s) => s.sources.includes("add")), ["library", "board", "reader"]);
  assert.deepEqual(where((s) => s.imports), ["library", "board", "reader", "review"]);
  assert.deepEqual(where((s) => (s.boardActions ?? []).length === 2), ["library", "board"]);
  for (const v of SOURCE_VERBS) assert.ok(where((s) => s.sources.includes(v)).length, `${v}: offered nowhere`);
  assert.deepEqual(where((s) => s.sources.includes("file")), ["library"]);
});

test("the table's fixed points hold: annotate in the reader only, plan and download on the board page only, grade off-schedule only in the cram", () => {
  const on = (cap: "annotate" | "plan" | "download") => ROUTES.filter((r) => SURFACES[r][cap]);
  assert.deepEqual(on("annotate"), ["reader"]);
  assert.deepEqual(on("plan"), ["board"]);
  assert.deepEqual(on("download"), ["board"]);
  assert.deepEqual(ROUTES.filter((r) => SURFACES[r].card.includes("grade-local")), ["cram"]);
  assert.ok(!SURFACES.cram.card.includes("grade"), "the cram never feeds the schedule");
  for (const r of ROUTES) assert.ok(SURFACES[r].feedback && SURFACES[r].suggest && SURFACES[r].replyToCard, `${r}: feedback, suggest and reply → card are everywhere`);
});

const SCREEN_FILES: Record<Route, string[]> = {
  library: ["web/surfaces/library/LibraryHome.tsx", "web/capabilities/keys/room-keys.ts"],
  board: ["web/shell/BoardRoute.tsx", "web/surfaces/reader/here.ts", "web/capabilities/keys/room-keys.ts"],
  reader: ["web/shell/BoardRoute.tsx", "web/surfaces/reader/here.ts", "web/capabilities/keys/room-keys.ts", "web/surfaces/reader/useSourceColumn.ts"],
  review: ["web/surfaces/review/ReviewSurface.tsx"],
  cram: ["web/surfaces/cram/CramSurface.tsx", "web/surfaces/cram/cram-load.ts"],
  keeps: ["web/surfaces/keeps/KeepsSurface.tsx", "web/surfaces/keeps/keeps-load.ts", "web/capabilities/keys/room-keys.ts"],
};
const THREAD_OPENED: Record<string, RegExp> = {
  library: /<Ask thread="library"/,
  board: /<Ask[^>]*thread=\{(askKey|boardId \? `board:\$\{boardId\}`)/,
  source: /threadFor\(threadRid \? "source" : "board"/,
  card: /<Ask key=\{card\.id\} thread=\{[^}]*cardThreadKey\(/,
  words: /sendTurn\(sourceThread\(/,
};

test("every screen mounts the Ask on the thread the table names, and says what is on it", () => {
  for (const r of ROUTES) {
    const spec = SURFACES[r], src = SCREEN_FILES[r].map((f) => readFileSync(f, "utf8")).join("\n");
    assert.match(src, /import Ask from "[./]*capabilities\/ask\/Ask\.[jt]sx"/, `${r}: mounts capabilities/ask`);
    assert.match(src, THREAD_OPENED[spec.ask], `${r}: opens its ${spec.ask} thread`);
    assert.match(src, new RegExp(`useProvideHere\\([^]*surface: [^,\\n]*"${r}"`), `${r}: publishes here with surface "${r}"`);
    assert.match(src, /openAsk\(\)/, `${r}: / opens the Ask`);
    const pending = PENDING[r] ?? [];
    if (spec.replyToCard && !pending.includes("replyToCard")) assert.match(src, /<Ask[^>]*onCompose=|onCompose=\{/, `${r}: a reply can become a card`);
  }
});

const CARD_MOUNTS: Partial<Record<Route, { files: string[]; note: RegExp; del: RegExp[]; history: RegExp }>> = {
  reader: {
    files: ["web/surfaces/reader/ReaderSurface.tsx", "web/capabilities/card/CardFrame.tsx"],
    note: /<CardMeta /,
    del: [/<CardForm [^/]*?onDelete=\{remove\}/, /onDelete=\{openQ \? null : reviewDeleteCard\}/, /onUndelete=\{undeleteCard\}/, /<CardDeleted /],
    history: /<CardHistory key=\{card\.id\} card=/,
  },
  review: { files: ["web/surfaces/review/ReviewSurface.tsx"], note: /<CardMeta /,
    del: [/onDelete=\{onDeleteCard \? \(\) => deleteCard\(card\)/], history: /<CardHistory / },
  cram: { files: ["web/surfaces/cram/CramSurface.tsx", "web/surfaces/cram/cram-load.ts"], note: /<CardMeta /,
    del: [/onDelete=\{onDeleteCard && !card\.mine \? \(\) => deleteCard\(card\)/], history: /<CardHistory / },
  keeps: { files: ["web/surfaces/keeps/KeepsSurface.tsx", "web/surfaces/keeps/keeps-load.ts"], note: /<FeedbackNote key=\{card\.id\}/,
    del: [/<CardForm [^/]*?onDelete=\{onDelete && deckOf\(card\)/, /onDelete=\{gone\.del\}/, /<CardDeleted /], history: /<CardHistory / },
};
test("every screen that drills or curates a card mounts the card's own edit, delete, ✎ note and history", () => {
  for (const [r, m] of Object.entries(CARD_MOUNTS)) {
    const spec = SURFACES[r as Route], src = m!.files.map((f) => readFileSync(f, "utf8")).join("\n");
    assert.match(src, /import CardForm\b[^;\n]*from "[./]*(capabilities\/card\/)?CardForm\.[jt]sx"/, `${r}: the card's own editor`);
    assert.match(src, m!.note, `${r}: the ✎ note, the shared one`);
    if (spec.card.includes("delete")) for (const d of m!.del) assert.match(src, d, `${r}: delete, from the card's editor (${d})`);
    if (spec.card.includes("history")) assert.match(src, m!.history, `${r}: the card's history`);
  }
  assert.doesNotMatch(readFileSync("web/capabilities/card/CardFrame.tsx", "utf8"), /FeedbackNote/, "reader: no private ✎ note");
});

test("nothing the table declares is pending: every screen does every live row it lists", () => {
  assert.deepEqual(PENDING, {});
});

test("PENDING names only live rows the table declares", () => {
  for (const [r, rows] of Object.entries(PENDING)) {
    for (const row of rows ?? []) {
      assert.ok((LIVE as readonly string[]).includes(row), `${r}: ${row} is not a live row`);
      assert.ok(SURFACES[r as Route][row], `${r}: ${row} is not declared, so it cannot be pending`);
    }
  }
});
