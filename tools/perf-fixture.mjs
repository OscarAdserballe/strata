// node tools/perf-fixture.mjs [out.db]: generate the production-shaped room the perf gate measures
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const out = resolve(process.argv[2] || "data/perf/fixture.db");
mkdirSync(dirname(out), { recursive: true });
for (const f of [out, `${out}-wal`, `${out}-shm`]) if (existsSync(f)) rmSync(f);
process.env.STRATA_DB = out;
process.env.GEMINI_API_KEY = "";
process.env.STRATA_FAKE_MODEL = "1";
// long books arrive whole here, so the generator lifts the per-source budget
process.env.STRATA_BUDGET_TOKENS = "100000000";

const { db } = await import("../server/platform/db/db.ts");
const { q } = await import("../server/features/repo.ts");
const { genId } = await import("../server/platform/db/sql.ts");
const { compileQuote, quoteAnchor } = await import("../shared/reading/compile-quote.ts");
const { insertResource } = await import("../server/features/sources/ingest.ts");
const { installDeck } = await import("../server/features/decks/decks.ts");
const { book, slides, scan } = await import("./fixture-pdf.mjs");
const { imagesRepo } = await import("../server/features/images/repo.ts");
const { imageIdOf } = await import("../server/features/images/images.ts");
const { imageRef } = await import("../shared/images/ref.ts");

const DAY = 864e5, NOW = Date.now();
let seed = 20260924;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
// quotes are picked from their own sequence, so the rest of the fixture is what it was before cards had quotes
let quoteSeed = 7;
const quoteRand = () => ((quoteSeed = (Math.imul(quoteSeed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rand() * a.length)];
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

function board(title, age = 30) {
  const id = genId("b-");
  q.insBoard.run(id, title, "blank", NOW - age * DAY, NOW - rand() * age * DAY);
  return id;
}
async function pdf(boardId, filename, doc) {
  return insertResource(boardId, { filename, kind: "pdf", mime: "application/pdf", data: b64(doc.bytes),
    sections: doc.sections, pageText: doc.pageText, tokens: Math.ceil(doc.pageText.join(" ").length / 4) });
}
async function prose(boardId, filename, text) {
  return insertResource(boardId, { filename, kind: "text", mime: "text/markdown", text, tokens: Math.ceil(text.length / 4) });
}
const sectionsOf = (rid) => q.sectionsOf.all(rid);

// a 1×1 PNG padded past its end to a shrunk screenshot's size, which is what the store and the wire see
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const images = Array.from({ length: 240 }, (_, i) => {
  const bytes = new Uint8Array(Buffer.concat([PNG, Buffer.alloc(60_000 + (i % 7) * 20_000, i % 251)]));
  const id = imageIdOf(bytes);
  imagesRepo.insImage.run(id, "image/png", 1600, 1000, bytes.length, bytes, NOW - i * 3600e3);
  return id;
});
let nextImage = 0;
const anImage = () => images[nextImage++ % images.length];

// a card sits on a verbatim quote; a page's running head and first words are its own even in a book that repeats itself
function quoteOnPage(pageText, p, first, last) {
  const words = (pageText[p - 1] || "").split(/\s+/).filter(Boolean);
  for (let k = 0; k < 4; k++) {
    const at = k ? Math.floor(quoteRand() * Math.max(1, words.length - 12)) : 0;
    const quote = words.slice(at, at + 10).join(" ");
    const r = compileQuote(quote, { pages: pageText, firstPage: first, lastPage: last });
    if (r.ok) return quoteAnchor(quote, r.at);
  }
  return `p. ${p}`;
}

// cards in production's mix: most on a quote that compiles, some (rooms never re-anchored, scanned pages) on nothing that does
function distilled(boardId, rid, section, pageText, { cards = 30, claims = 8 } = {}) {
  const first = section.first_page, last = section.last_page || pageText.length;
  const pageIn = () => first + Math.floor(rand() * Math.max(1, last - first + 1));
  const excerptFrom = (p) => { const t = pageText[p - 1] || ""; const at = Math.floor(rand() * Math.max(1, t.length - 160)); return t.slice(at, at + 120).trim(); };
  const nodes = Array.from({ length: claims }, (_, i) => ({
    id: `n${i + 1}`, label: `Claim ${i + 1} of ${section.label}`, kind: i ? "concept" : "synthesis",
    anchor: `p. ${pageIn()}`, questions: [`Why does claim ${i + 1} hold?`], excerpt: "", children: [],
  }));
  const tree = { title: section.label, question: `What does ${section.label} argue?`, nodes };
  q.upsertTree.run(section.id, rid, boardId, tree.title, tree.question, JSON.stringify(tree), "", "ready", null, 0, NOW);
  // a distilled deck follows its source, as distil's claims do
  const deck = Array.from({ length: cards }, (_, i) => {
    // its first card asks about the section's opening, as a distilled deck's does
    const drawn = pageIn(), p = i === 0 ? first : drawn, r = rand();
    const source = r < 0.88 ? quoteOnPage(pageText, p, first, last) : r < 0.94 ? `p. ${p}` : r < 0.97 ? `#claim-${i}` : "";
    return { p, card: { node: `n${1 + (i % claims)}`, source, excerpt: excerptFrom(p), tags: [], asks: [],
      front: `${section.label}: question ${i + 1} — what follows from the passage on page ${p}?`,
      back: `Because of the argument on page ${p}. ${i % 3 === 0 ? "The rate is $r = \\frac{\\delta}{1-\\delta}$." : ""}${i % 12 === 5 ? `\n${imageRef(anImage())}` : ""}` } };
  }).sort((x, y) => x.p - y.p).map((x) => x.card);
  const n = installDeck(boardId, section.id, section.label, deck);
  q.upsertTree.run(section.id, rid, boardId, tree.title, tree.question, JSON.stringify(tree), "", "ready", null, n, NOW);
  return n;
}

function essay() {
  const paras = book().pageText;
  let md = "# A Long Essay on Coordination\n\n";
  for (let s = 1; md.length < 330_000; s++) {
    md += `## ${Math.ceil(s / 4)}.${((s - 1) % 4) + 1} Section ${s}\n\n`;
    for (let k = 0; k < 6; k++) md += paras[(s * 6 + k) % paras.length] + (k % 4 === 0 ? " The condition is $\\delta \\geq \\frac{1}{2}$." : "") + "\n\n";
  }
  return md;
}

const shape = {};
const t0 = performance.now();

function highlight(boardId, rid, pageText, count, from = 3) {
  for (let m = 0; m < count; m++) {
    const page = from + (m % (pageText.length - from)), text = pageText[page - 1];
    const start = Math.floor(rand() * Math.max(1, text.length - 120)), end = start + 40 + Math.floor(rand() * 80);
    const y = 0.1 + rand() * 0.75;
    q.insMark.run(genId("m-"), boardId, rid, page, start, end, text.slice(start, end), m % 6 === 0 ? `A note on highlight ${m}.` : null,
      JSON.stringify([[0.1, y, 0.8, 0.018], [0.1, y + 0.02, 0.5, 0.018]]), null, NOW - m * 3600e3, NOW - m * 3600e3);
  }
}

for (let i = 1; i <= 26; i++) {
  const id = board(`Course ${String(i).padStart(2, "0")}`);
  for (let d = 1; d <= 6; d++) {
    const deck = slides();
    const rid = await pdf(id, `Lecture ${d}.pdf`, deck);
    for (const s of sectionsOf(rid)) distilled(id, rid, s, deck.pageText, { cards: 45 });
  }
  for (let r = 1; r <= 2; r++) {
    const b = book();
    const rid = await pdf(id, `Reader ${i}.${r}.pdf`, b);
    for (const s of sectionsOf(rid)) distilled(id, rid, s, b.pageText, { cards: 60 });
    if (r === 1) highlight(id, rid, b.pageText, 90);
  }
  const note = `# Course ${i} notes\n\n` + book().pageText.slice(0, 12).join("\n\n");
  const nid = await prose(id, `Notes ${i}.md`, note);
  for (const s of sectionsOf(nid)) installDeck(id, s.id, s.label, Array.from({ length: 10 }, (_, k) => ({
    node: "n1", source: "", excerpt: note.slice(k * 300, k * 300 + 100), tags: [], asks: [], front: `Note ${i} question ${k}?`, back: "From the notes." })));
  for (let m = 0; m < 50; m++) q.insMsg.run(id, null, m % 2 ? "assistant" : "user", m % 2 ? "Here is the short answer, with $x^2$ in it." : `Question ${m}?`, null, "[]", m + 1, NOW - (50 - m) * 60e3);
}

const long = book({ title: "A Long Book", pagesPerChapter: 22,
  chapters: Array.from({ length: 26 }, (_, i) => `Chapter ${i + 1}: the ${["first", "second", "third"][i % 3]} turn of the argument`) });
const longBoard = board("Long book");
const longRid = await pdf(longBoard, "A Long Book.pdf", long);
for (const s of sectionsOf(longRid)) distilled(longBoard, longRid, s, long.pageText, { cards: 60, claims: 12 });

const scanned = scan({ pages: 46 });
const scanBoard = board("Scanned readings");
const scanRid = await pdf(scanBoard, "Scanned Course Reader.pdf", scanned);
for (const s of sectionsOf(scanRid)) distilled(scanBoard, scanRid, s, scanned.pageText, { cards: 40 });

const marked = book({ title: "The Marked Book" });
const markBoard = board("Marked reading");
const markRid = await pdf(markBoard, "The Marked Book.pdf", marked);
// a second source, so a journey can leave the book and return, and the board has production's mark count
const seminar = slides();
highlight(markBoard, await pdf(markBoard, "Seminar slides.pdf", seminar), seminar.pageText, 180, 1);
const reader = book({ title: "A Seminar Reader" });
highlight(markBoard, await pdf(markBoard, "A Seminar Reader.pdf", reader), reader.pageText, 250);
for (const s of sectionsOf(markRid)) distilled(markBoard, markRid, s, marked.pageText, { cards: 25 });
highlight(markBoard, markRid, marked.pageText, 260);
for (let m = 0; m < 600; m++) {
  const user = m % 2 === 0;
  q.insMsg.run(markBoard, markRid, user ? "user" : "assistant", user ? `${m % 20 === 0 ? `${imageRef(anImage())}\n` : ""}Question ${m / 2}: what does page ${1 + (m % 80)} mean?`
    : `It argues that **coordination** is sustained by repetition. ${m % 3 === 1 ? "Formally, collusion holds when $$\\frac{\\pi_c}{1-\\delta} \\geq \\pi_d + \\frac{\\delta \\pi_n}{1-\\delta}$$ and $\\delta$ is the discount factor." : "See the passage on the next page."}\n\n- first point\n- second point`,
    null, "[]", m + 1, NOW - (600 - m) * 60e3);
}

const essayText = essay();
const essayBoard = board("Long essay");
const essayRid = await prose(essayBoard, "A Long Essay.md", essayText);
await pdf(essayBoard, "Essay seminar.pdf", slides());
for (const s of sectionsOf(essayRid)) {
  const n = installDeck(essayBoard, s.id, s.label, Array.from({ length: 60 }, (_, i) => {
    const at = Math.floor(rand() * (essayText.length - 200)), words = essayText.slice(at, at + 100).replace(/[#$\\]/g, "").trim();
    // a section's heading and its first words are its own: the essay's paragraphs repeat
    const heads = [...essayText.matchAll(/^## .+$/gm)], h = heads[Math.floor(quoteRand() * heads.length)];
    const quote = essayText.slice(h.index + 3).split(/\s+/).slice(0, 10).join(" ");
    const c = compileQuote(quote, { text: essayText });
    const r = rand();
    return { node: "n1", source: r < 0.85 && c.ok ? quoteAnchor(quote, c.at) : r < 0.93 ? `§${1 + (i % 40)}.${1 + (i % 4)}` : "", excerpt: words,
      tags: [], asks: [], front: `Essay question ${i + 1}?`, back: "Because the essay says so." };
  }));
  q.upsertTree.run(s.id, essayRid, essayBoard, s.label, "", JSON.stringify({ title: s.label, question: "", nodes: [] }), "", "ready", null, n, NOW);
}
for (let m = 0; m < 120; m++) {
  const start = Math.floor(rand() * (essayText.length - 200));
  q.insMark.run(genId("m-"), essayBoard, essayRid, null, start, start + 60, essayText.slice(start, start + 60), m % 5 === 0 ? `Essay note ${m}.` : null, null, null, NOW, NOW);
}

const allCards = q.allCards.all();
for (let k = 0; k < 700; k++) { const c = allCards[(k * 13) % allCards.length]; q.insKeep.run(c.id, c.course, c.deck, NOW - (k % 60) * DAY); }
const boards = q.boards.all().map((b) => b.id);
const ev = db.prepare("INSERT INTO events (ts, session, app, event, props) VALUES (?, ?, 'strata', ?, ?)");
const MIX = [["request", 0.70], ["deck_open", 0.15], ["board_view", 0.022], ["card_show", 0.018], ["read_progress", 0.017],
  ["card_reveal", 0.013], ["card_grade", 0.012], ["mark_add", 0.007], ["board_leave", 0.01], ["resource_view", 0.004], ["chat_turn", 0.003], ["card_keep", 0.024]];
db.exec("BEGIN");
const EVENTS = 350_000;
for (let i = 0; i < EVENTS; i++) {
  const ts = NOW - 45 * DAY + Math.floor((i / EVENTS) * 45 * DAY);
  let r = rand(), name = MIX[0][0];
  for (const [n, w] of MIX) { if ((r -= w) <= 0) { name = n; break; } }
  const b = pick(boards), c = allCards[i % allCards.length];
  const props = name === "request" ? { method: "GET", path: `/api/boards/${b}`, status: 200, ms: 5 + (i % 90) }
    : name === "card_grade" || name === "card_show" || name === "card_reveal" ? { card: c.id, deck: c.deck, board: b, got: rand() < 0.7, review: rand() < 0.5 }
    : name === "read_progress" ? { board: b, resource: null, pct: i % 100, deepest: i % 100, ms: 15000 }
    : { board: b };
  ev.run(ts, `s${i % 400}`, name, JSON.stringify(props));
}
db.exec("COMMIT");
db.exec("PRAGMA optimize = 0x10002");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

for (const t of ["boards", "resources", "resource_blobs", "sections", "pairs", "trees", "cards", "card_keeps", "marks", "messages", "events", "images"])
  shape[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
shape.largestBlobBytes = db.prepare("SELECT MAX(length(bytes)) n FROM resource_blobs").get().n;
shape.largestProseBytes = db.prepare("SELECT MAX(length(text)) n FROM resources").get().n;
shape.maxMarksPerSource = db.prepare("SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM marks GROUP BY resource_id)").get().n;
shape.maxMarksPerBoard = db.prepare("SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM marks GROUP BY board_id)").get().n;
shape.maxMessagesPerBoard = db.prepare("SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM messages GROUP BY board_id)").get().n;
db.close();
writeFileSync(`${out}.shape.json`, JSON.stringify(shape, null, 2) + "\n");
console.log(`perf fixture: ${out} in ${Math.round(performance.now() - t0)} ms`);
console.log(JSON.stringify(shape));
