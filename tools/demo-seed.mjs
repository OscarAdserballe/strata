// node tools/demo-seed.mjs URL: seed the preview with a book, a slide deck, an essay and a few more boards.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { book, slides } from "./fixture-pdf.mjs";
import { compileQuote, quoteAnchor } from "../shared/reading/compile-quote.ts";

const BASE = process.argv[2] || "http://127.0.0.1:8804";
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");

const j = async (path, opts) => {
  const r = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...(opts || {}) });
  if (!r.ok) throw new Error(`${opts?.method || "GET"} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};
const newBoard = async (title) => (await j("/api/boards", { method: "POST", body: JSON.stringify({ title }) })).board;
const setLog = (id, text) => fetch(`${BASE}/api/boards/${id}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
const addSource = (id, body) => j(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify(body) });
const addPair = (id, body) => j(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify(body) });
const putTree = (id, rid, sid, tree, cards) =>
  j(`/api/boards/${id}/resources/${rid}/tree${sid ? `?section=${sid}` : ""}`, { method: "PUT", body: JSON.stringify({ tree, cards }) });
// a card sits on a verbatim quote, compiled here as the server and the reader compile it: a seed that doesn't compile fails loudly
const placed = (quote, src) => {
  const r = compileQuote(quote, src);
  if (!r.ok) throw new Error(`seed card quote doesn't compile: ${r.error}`);
  return quoteAnchor(quote, r.at);
};
// the fixture book repeats its paragraphs: a page's running head and its first words are what is its own
const onPage = (pageText, n) => placed(pageText[n - 1].split(/\s+/).filter(Boolean).slice(0, 9).join(" "), { pages: pageText });
// marks are found in the seeded text rather than guessed, so findQuote re-finds them like real ones
const addMark = (id, body) => j(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify(body) });
const markIn = (id, rid, text, quote, note) => {
  // spacing-insensitive like findQuote: the source is hard-wrapped and a selection runs across line breaks
  const rx = new RegExp(quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
  const m = rx.exec(text);
  if (!m) throw new Error("seed mark: that quote is not in the source — " + quote.slice(0, 44));
  return addMark(id, { resourceId: rid, page: null, start: m.index, end: m.index + m[0].length, quote: m[0], note: note || null });
};

const decks = (await j("/api/decks")).decks;
const deckOf = (slug) => (decks.some((d) => d.slug === slug) ? slug : null);

const b = book();
const bookBoard = await newBoard("The Discipline of Repetition");
await setLog(bookBoard.id, `# Reading a book — the log

**Preview fixture.** This board holds one source: an 89-page book whose author left twelve
bookmarks. Eight are chapters; four are apparatus — the title page, the dedication, the notes
and the index — which is what a real book's bookmarks look like, and why length alone cannot
tell the work from what it is bound with.

What this board is for looking at:

- the whole book scrolls continuously, and a page is drawn only when you reach it
- opening a chapter lands on its first page; reading on into the next lights it in the status line
- **marks**: select a passage anywhere and it stays highlighted, with room for a note beside it

The prose is original and repeats deliberately. It is scaffolding, not reading.
`);
const bookRes = await addSource(bookBoard.id, {
  filename: "the-discipline-of-repetition.pdf",
  base64: b.bytes.toString("base64"),
  sections: b.sections,
  pageText: b.pageText,
});
console.log(`· book: ${b.pages} pages → ${bookRes.sections} sections`);

// chapter one gets a tree and deck anchored inside its own pages, so pins land without a model key
const state = await j(`/api/boards/${bookBoard.id}`);
const ch1 = (state.sections || []).find((s) => /\bOne:/.test(s.label));
if (ch1) {
  await putTree(bookBoard.id, bookRes.id, ch1.id, {
    title: "What a market is, and who decides",
    question: "What settles the boundary of a market, and why does the answer depend on the question being asked?",
    glossary: [
      { term: "Substitutability", kernel: "Whether a buyer would switch between two products in response to a price change.", anchor: "p. 3" },
      { term: "Distribution reach", kernel: "The set of buyers a seller can actually supply through its existing channels.", anchor: "p. 4" },
      { term: "Tacit collusion", kernel: "Prices held above the competitive level with no agreement, sustained only by repetition.", anchor: "p. 6" },
    ],
    nodes: [
      {
        label: "A market's boundary is a property of the question, not of the world",
        kind: "concept", anchor: "p. 3",
        questions: ["Why do two definitions of the same market disagree about who competes with whom?"],
        excerpt: "A market defined by the substitutability of products will not be the market defined by the reach of a distribution network.",
        children: [
          { label: "Substitutability and distribution reach give different boundaries", kind: "concept", anchor: "p. 4", questions: ["Which definition should decide a merger case, and on what grounds?"] },
          { label: "The approximation fails where horizons are long and information is poor", kind: "claim", anchor: "p. 5", questions: ["Where does profit maximisation stop predicting behaviour?"] },
        ],
      },
      {
        label: "Coordination among a few firms needs no agreement, only repetition",
        kind: "concept", anchor: "p. 6",
        questions: ["How can three firms coordinate without exchanging a word?"],
        excerpt: "A price cut today is a price cut that will be met tomorrow.",
        children: [
          { label: "Being reliably met removes the reason to cut at all", kind: "claim", anchor: "p. 7", questions: ["Why is meeting a cut enough to prevent it?"] },
        ],
      },
    ],
  }, [
    // layer 0 is decided by the card, not its node, so a term defined under an L2 claim still comes first
    { node: "n1", type: "flashcard", introduces: "Substitutability", source: onPage(b.pageText, 3), front: "Substitutability", back: "Whether a buyer would switch between two products in response to a price change." },
    { node: "n1.1", type: "flashcard", introduces: "Distribution reach", source: onPage(b.pageText, 4), front: "Distribution reach", back: "The set of buyers a seller can actually supply through its existing channels." },
    { node: "n2", type: "flashcard", introduces: "Tacit collusion", source: onPage(b.pageText, 6), front: "Tacit collusion", back: "Prices held above the competitive level with no agreement, sustained only by repetition." },
    { node: "n1", type: "flashcard", source: onPage(b.pageText, 3), front: "Why is the boundary of a market a property of the question rather than of the world?", back: "Because different questions pick out different substitution relations: products substitutable in use need not be reachable through the same distribution network, so the two definitions disagree about who competes with whom." },
    { node: "n1.1", type: "flashcard", source: onPage(b.pageText, 4), front: "Name two definitions of a market that can disagree, and say what they disagree about.", back: "Substitutability of products versus reach of a distribution network. They disagree about the set of firms counted as competitors." },
    { node: "n1.2", type: "flashcard", source: onPage(b.pageText, 5), front: "Where does the profit-maximisation approximation characteristically fail?", back: "Where the time horizon is long and the information is poor." },
    { node: "n2", type: "flashcard", source: onPage(b.pageText, 6), front: "What sustains coordination among three firms that never communicate?", back: "Repetition. A price cut will be met tomorrow, so a firm that can count on being met has no reason to cut — what looks like an agreement is a series of individually sensible unilateral decisions." },
    { node: "n2.1", type: "flashcard", source: onPage(b.pageText, 7), front: "A firm expects any price cut to be matched within a day. What follows?", back: "It has no reason to cut at all: the gain from cutting lasts only as long as it goes unmatched." },
  ]);
  console.log("· book: chapter one has a tree (3 terms) and 8 cards — 3 of them layer 0");
}

const s = slides();
const slideBoard = await newBoard("Advanced Industrial Organisation");
await setLog(slideBoard.id, `# Advanced Industrial Organisation — the log

**Preview fixture.** A course board: a slide deck paired with a committed deck of cards, plus
a few card-only pairs so \`g\` has a list to be a list of.

The deck has **no bookmarks**, which is correct — a real one does not have them either. It is
therefore exactly one section and behaves precisely as every source did before books existed.
That is the case most likely to break when something changes, so it is worth having on its own board.

What I actually want to hold on to from lecture 4:

- The whole cartel literature is *one inequality* with different terms enlarged.
- "Detection lag" and "impatience" are the same parameter wearing two hats.
- Leniency is interesting because it attacks a payoff the cartel has no instrument against.
`);
const slideRes = await addSource(slideBoard.id, {
  filename: "lecture4.collusion.pdf",
  base64: s.bytes.toString("base64"),
  pageText: s.pageText,
});
await addPair(slideBoard.id, { label: "4 · Collusion", resourceId: slideRes.id, deck: deckOf("aio-lecture-4") });
console.log(`· slides: ${s.pages} pages → 1 section`);

for (const [label, deck] of [["5 · Advertising", "aio-lecture-5"], ["6 · Horizontal mergers", "aio-lecture-6"], ["9 · Innovation", "aio-lecture-9"]]) {
  await addPair(slideBoard.id, { label, deck: deckOf(deck) });
}

const samplePath = join(APP, "design/samples/lecture4-collusion.json");
if (existsSync(samplePath)) {
  const sample = JSON.parse(readFileSync(samplePath, "utf-8"));
  await putTree(slideBoard.id, slideRes.id, null, sample.tree, undefined);
  console.log("· slides: tree from the recorded sample,", sample.tree.nodes.length, "root claims");
} else {
  // the recorded sample is not part of the repository; a preview without it still stands
  console.log("· slides: no recorded sample at design/samples — the slide deck stays tree-less");
}

const ESSAY = `# The identification problem

## 1 What the data cannot tell you

The observable outcome of tacit coordination and the **observable outcome** of vigorous
competition under high fixed costs are very nearly the same outcome. Prices sit above
marginal cost in both. They move together in both. No amount of *price data alone* will
separate them, and the history of the field is in large part a history of stories told
slightly differently until the data stopped objecting.

(Emphasis on this page is deliberate: a highlight that runs across a bold or italic span
has to come out as one mark, and this is where that is checked. Note that emphasis must
open and close on the SAME source line — the renderer parses inline markup per line.)

## 2 The fingerprints, and why none of them is conclusive

The obvious response is to look for the fingerprints of coordination rather than for
coordination itself.

### 2.1 Sudden alignment

A period of dispersion that collapses into agreement is suggestive. It is also exactly what
happens when a cost shock hits every firm at once, which is why the inference needs the cost
data as well as the price data.

### 2.2 Asymmetric response

Prices that move together on the way up and apart on the way down are the classic pattern.
The competitive explanation is search frictions, and it fits nearly as well.

### 2.3 Insensitivity to cost shocks

A price that ignores a cost increase it ought to have passed through is hard to explain
competitively. This is the strongest of the three, and it is still not proof.

## 3 Why entry changes the picture

An arrangement that survives among three firms rarely survives among six. The reason is not
that six is harder to coordinate, though it is; it is that the gain from defecting rises as
each participant's share of the collusive profit falls.

## 4 What follows for policy

If the outcome cannot be identified from the outcome, the instrument has to work on
something else. Leniency does: it changes the payoff to confessing, which is a payoff the
arrangement has no way to punish.

### 4.1 The design detail that decides it

Leniency for the second confessor undoes most of the effect. The programme works by making
the race to confess winner-take-all, and a programme that softens that race is a programme
that does nothing.
`;

const TRANSCRIPT = `# Coordination without agreement — a talk

[00:00] I want to start with something that sounds like a paradox and isn't. You can have
what looks exactly like a cartel, with prices well above cost, holding for years, and no
agreement anywhere. Nobody met. Nobody wrote anything down.

[00:41] The mechanism is repetition, and it's worth being precise about why repetition
changes things. In a one-shot game the incentive is clear: undercut, take the market, take
the profit. There's no tomorrow in which anything happens to you.

[01:35] Now put a tomorrow in it. Your cut gets matched. You had one good day and now you're
in a worse world permanently. If you can count on being matched, you never cut, and I never
cut, and neither of us has agreed to anything.

[02:20] The thing that makes this hard empirically is that it looks identical to competition
under high fixed costs. Same prices, same movements. This is what people mean by the
identification problem, and it is not a small technical difficulty — it is the central one.

[03:14] So what do you do? You stop looking for the arrangement and start looking for what
it would leave behind. Sudden alignment after dispersion. Prices that rise together and fall
apart. A cost shock that should have passed through and didn't.

[04:02] None of those is conclusive on its own. I want to be honest about that, because the
screening literature sometimes oversells itself. Each one has a competitive story that fits
nearly as well.

[04:55] Where it gets interesting is when you stop trying to detect and start trying to
destabilise. If you can give one participant a reason to defect that the others cannot
punish, you don't need to detect anything at all.

[05:40] That's leniency, and its record is genuinely good. The design matters enormously
though — if the second firm to confess also gets a discount, you've turned a race into a
queue, and a queue is something a cartel can manage.
`;

const essayBoard = await newBoard("Reading — the identification problem");
await setLog(essayBoard.id, `# Reading — the log

**Preview fixture.** Two prose formats side by side, because they render and anchor
differently and both have to be judged:

- **the essay** — markdown as typography, anchored by numbered heading (\`§2.1\`)
- **the talk** — a transcript, anchored by the clock (\`[04:55]\`), a timestamp every ~45 seconds

Both are plain text in the reading column, which is the case where selecting a passage is
easiest and therefore the one that should be got right first.
`);
const essayRes = await addSource(essayBoard.id, { filename: "identification-problem.md", text: ESSAY });
await addPair(essayBoard.id, { label: "The identification problem", resourceId: essayRes.id });
const talkRes = await addSource(essayBoard.id, { filename: "coordination-without-agreement.md", text: TRANSCRIPT, kind: "transcript" });
await addPair(essayBoard.id, { label: "Coordination without agreement — a talk", resourceId: talkRes.id });

await putTree(essayBoard.id, essayRes.id, null, {
  title: "The identification problem",
  question: "If collusion and competition look the same in the data, what can policy act on instead?",
  nodes: [
    {
      label: "Tacit coordination and competition under high fixed costs are observationally the same",
      kind: "concept", anchor: "§1",
      questions: ["Why will price data alone not separate the two?"],
      excerpt: "Prices sit above marginal cost in both. They move together in both.",
      children: [
        { label: "Sudden alignment has a competitive explanation too", kind: "claim", anchor: "§2.1", questions: ["What else produces a collapse from dispersion into agreement?"] },
        { label: "Asymmetric response is explained nearly as well by search frictions", kind: "claim", anchor: "§2.2", questions: ["What is the competitive story for rockets and feathers?"] },
        { label: "Insensitivity to cost shocks is the strongest fingerprint, and still not proof", kind: "claim", anchor: "§2.3", questions: ["Why is an unpassed cost increase hard to explain competitively?"] },
      ],
    },
    {
      label: "Entry destabilises the arrangement by shrinking each participant's collusive share",
      kind: "concept", anchor: "§3",
      questions: ["Why does the defection gain rise with the number of firms?"],
    },
    {
      label: "Leniency works because it attacks a payoff the arrangement cannot punish",
      kind: "concept", anchor: "§4",
      questions: ["What makes confessing different from every other deviation?"],
      children: [
        { label: "A discount for the second confessor turns the race into a queue", kind: "claim", anchor: "§4.1", questions: ["Why must leniency be winner-take-all?"] },
      ],
    },
  ],
}, [
  { node: "n1", type: "flashcard", source: placed('No amount of *price data alone* will separate them', { text: ESSAY }), front: "Why can price data alone not distinguish tacit collusion from competition under high fixed costs?", back: "Both produce prices above marginal cost that move together. The observable outcome is very nearly identical, so the data cannot referee between the two stories." },
  { node: "n1.1", type: "flashcard", source: placed('It is also exactly what happens when a cost shock hits every firm at once', { text: ESSAY }), front: "Sudden alignment after a period of price dispersion — what is the competitive explanation?", back: "A cost shock hitting every firm at once. Which is why the inference needs cost data, not just price data." },
  { node: "n1.3", type: "flashcard", source: placed('A price that ignores a cost increase it ought to have passed through is hard to explain', { text: ESSAY }), front: "Which fingerprint of coordination is strongest, and why is it still not proof?", back: "A price that ignores a cost increase it should have passed through. It is hard to explain competitively, but 'hard' is not 'impossible'." },
  { node: "n2", type: "flashcard", source: placed("the gain from defecting rises as each participant's share of the collusive profit falls", { text: ESSAY }), front: "Why does an arrangement surviving among three firms often fail among six?", back: "Each participant's share of the collusive profit falls as the number rises, while the gain from defecting does not — so defection becomes relatively more attractive." },
  { node: "n3", type: "flashcard", source: placed('it changes the payoff to confessing, which is a payoff the arrangement has no way to punish', { text: ESSAY }), front: "What makes confessing a payoff the cartel has no instrument against?", back: "Every other deviation can be met with punishment inside the market. A confession ends the arrangement outright, so there is no future in which punishment can land." },
  { node: "n3.1", type: "flashcard", source: placed('Leniency for the second confessor undoes most of the effect', { text: ESSAY }), front: "A leniency programme also gives a partial discount to the second firm to confess. What is the effect?", back: "The race becomes a queue, and most of the effect is lost: winner-take-all is what makes confessing urgent, and a discount for second place removes the urgency." },
]);
await markIn(essayBoard.id, essayRes.id, ESSAY,
  "the history of the field is in large part a history of stories told slightly differently until the data stopped objecting",
  "The sharpest sentence in it. Worth keeping for the shape of the argument, not the content.");
await markIn(essayBoard.id, essayRes.id, ESSAY,
  "This is the strongest of the three, and it is still not proof.");
await markIn(essayBoard.id, talkRes.id, TRANSCRIPT,
  "you've turned a race into a queue, and a queue is something a cartel can manage",
  "The design detail that decides the whole programme. Ask: is second-mover leniency ever defensible?");
console.log("· essay: tree and 6 cards; transcript beside it; three marks kept");

// boards in the states a shelf really holds, including the empty ones a home page usually forgets

const FE_LOG = `# Financial Econometrics — the log

Exam in January. The reading is done; what is not done is being able to *produce* the
derivations under time pressure, which is why this board is mostly decks.

- Cointegration I can recognise. I cannot yet derive the Johansen trace statistic cold.
- The unit-root asymptotics are the part I keep re-reading and never keep.
- Open question I have not answered: **do I own cointegration, or do I only recognise it?**
`;
const feBoard = await newBoard("Financial Econometrics");
await setLog(feBoard.id, FE_LOG);
for (const [label, deck] of [["Derivatives", "derivatives"], ["Unit roots", "aio-lecture-7"], ["Cointegration", "aio-lecture-8"]]) {
  await addPair(feBoard.id, { label, deck: deckOf(deck) });
}
console.log("· fe: three card-only pairs, no source");

const LEDGER = `# The append-only ledger

## 1 What the ledger refuses

The ledger is not a file format. It is a set of refusals, and the refusals are the
design: it will not accept a record it cannot account for, it will not grow past a budget
it was given at construction, and it will not report success for a write it has not
flushed.

## 2 The budget check precedes the append

The check has to gate the cost, not report it. After the append the memory is already
spent, and a check that runs there is not a check — it is a log line about damage.

## 3 Failing closed is not failing fast

Failing fast returns an error as soon as it knows. Failing closed decides what the system
looks like *after* the error, and for a ledger that is the only interesting half: a
truncated file that replays is worth more than a complete one that does not exist.
`;
const codeBoard = await newBoard("Reading a codebase — the write path");
await setLog(codeBoard.id, `# The write path — the log

Reading the append path not as "what does this do" but "what does this refuse, and why there".

- The budget check must precede the append rather than follow it.
- Failing closed ≠ failing fast — see §3, that distinction is the whole chapter.
- Next: the replay path.
`);
const codeRes = await addSource(codeBoard.id, { filename: "the-append-only-ledger.md", text: LEDGER });
await addPair(codeBoard.id, { label: "The append-only ledger", resourceId: codeRes.id });
await markIn(codeBoard.id, codeRes.id, LEDGER,
  "a truncated file that replays is worth more than a complete one that does not exist",
  "The line I keep coming back to. Failing closed is a claim about the wreckage.");
console.log("· codebase: one prose source, a live log, one mark");

const gapBoard = await newBoard("Overcoming the hot/cold empathy gap");
await setLog(gapBoard.id, `Why do cold-state plans lose to hot-state moments?

Nothing read yet. This board is a question I want to hold, not a course.
`);
console.log("· gap: a declared question, nothing under it");

await newBoard("Care of the self");
console.log("· care: empty — no log, no sources, no pairs");

// a board's purpose and milestones, one ticked and one dated, so the front page shows its plan
const plan = (id, path, method, body) => j(`/api/boards/${id}/plan/${path}`, { method, body: JSON.stringify(body) });
await plan(slideBoard.id, "purpose", "PUT", { purpose: "Pass the AIO exam on 12 December" });
const ms1 = await plan(slideBoard.id, "milestones", "POST", { name: "Lectures 1–4 drilled" });
await plan(slideBoard.id, `milestones/${ms1.id}`, "PATCH", { done: true });
const ms2 = await plan(slideBoard.id, "milestones", "POST", { name: "Collusion problem set" });
await plan(slideBoard.id, `milestones/${ms2.id}`, "PATCH", { due: "28 Nov", note: "Grim trigger, then the n-firm threshold." });
await plan(feBoard.id, "purpose", "PUT", { purpose: "Own the derivations, not just recognise them" });
await plan(feBoard.id, "milestones", "POST", { name: "Johansen trace statistic, cold" });
console.log("· plans: the slide deck's board has a purpose and two milestones; econometrics a purpose and one");

// an agent's live page, with a note in each state a reader meets: one waiting on the agent, one the agent answered
const EXPLORATION = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review ladder — three layouts</title>
<style>body{font:16px/1.55 Georgia,serif;color:#1f1b16;background:#fbf8f2;max-width:760px;margin:40px auto;padding:0 20px}
h1{font-size:30px;margin:0 0 6px}h2{font-size:20px;margin:0 0 8px}.lede{color:#6b6255;margin:0 0 28px}
section{border:1px solid #e3dccf;border-radius:10px;padding:16px 18px;margin:0 0 16px;background:#fff}
.rungs{display:flex;gap:6px;margin-top:10px}.rungs span{flex:1;height:10px;border-radius:5px;background:#e3dccf}.rungs span.on{background:#b5562a}</style></head>
<body><h1>Review ladder — three layouts</h1>
<p class="lede">How the review strip could show where each kept card sits on its ladder, from quietest to loudest.</p>
<section data-strata-id="A"><h2>A · A count per rung</h2><p>Five numbers under the strip. Cheap to read, says nothing about which card is where.</p>
<div class="rungs"><span class="on"></span><span class="on"></span><span></span><span></span><span></span></div></section>
<section data-strata-id="B"><h2>B · A pip per card</h2><p>Every kept card is a pip on its rung, so a stuck card shows as a pile on the bottom rung.</p>
<div class="rungs"><span class="on"></span><span></span><span class="on"></span><span></span><span></span></div></section>
<section data-strata-id="C"><h2>C · Only the stuck ones</h2><p>Nothing until a card has missed twice on the same rung; then it is named, with its source.</p></section>
<script>window.strata && window.strata.load().then(function (s) { if (s && s.pick) document.title += " · picked " + s.pick; });</script>
</body></html>`;
const exploreBoard = await newBoard("Strata — explorations");
const exploreRes = await addSource(exploreBoard.id, { filename: "review-ladder.html", base64: Buffer.from(EXPLORATION).toString("base64"), study: false });
await addPair(exploreBoard.id, { label: "Review ladder — three layouts", resourceId: exploreRes.id });
const note = (body) => j(`/api/boards/${exploreBoard.id}/marks`, { method: "POST", body: JSON.stringify({ resourceId: exploreRes.id, start: 0, end: 0, ...body }) });
const onB = await note({ box: "B", quote: "B · A pip per card", note: "This one — but the pile on the bottom rung needs its count, or ten pips read as a smear." });
await note({ quote: "says nothing about which card is where", note: "Is that a problem on a phone, where there is no room for B anyway?" });
const token = (await j("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "preview seed", write: true }) })).token;
const agent = async (name, args) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  if (!res || res.isError) throw new Error(`seed ${name}: ${res?.content?.[0]?.text ?? r.status}`);
};
await agent("apply", { board: exploreBoard.id, key: "seed-explorations-1", ops: [
  { op: "set_handle", handle: "explorations" },
  { op: "reply_note", id: `hl_${onB.id}`, text: "Added the count over the bottom rung's pile in B." },
] });
console.log("· explorations: a live HTML page, a note waiting on the agent and one it answered");

// the dashboard: threads in every open stage, both areas, one picked for tomorrow morning, and an inbox
const task = (body) => j("/api/dashboard/tasks", { method: "POST", body: JSON.stringify(body) });
const patch = (id, body) => j(`/api/dashboard/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) });
await task({ id: "t_review01", title: "Show the review ladder on the strip", area: "work",
  body: "## Context\nKept cards return on a ladder, but the strip only shows a total.\n\n## Done when\n- Each kept card's rung is visible from home\n- A stuck card is named with its source\n\n## Research\nThree layouts on the explorations board; B (a pip per card) was picked, with a count over the bottom rung.\n\nLeft for you: whether the phone door shows the ladder at all.\n\n## Sources\n- explorations/review-ladder.html — the three layouts and the comment thread" });
await patch("t_review01", { stage: "thinking" });
await task({ id: "t_reviewa1", title: "Draw B with a count on the bottom rung", area: "work", stage: "review" });
await task({ id: "t_exam0001", title: "Register for the January exam", area: "personal" });
await patch("t_exam0001", { morning: true });
await task({ id: "t_johansen", title: "Derive the Johansen trace statistic cold", area: "personal" });
await j("/api/dashboard/inbox", { method: "POST", body: JSON.stringify({ kind: "task", title: "Split the slide deck's one section", area: "work",
  context: "The lecture-four deck has 23 pages in one section, so it makes one deck.", from: { source: "You" } }) });
await j("/api/dashboard/inbox", { method: "POST", body: JSON.stringify({ title: "B reads well on desktop; on a 390px phone the pips run off the strip", area: "work", context: "Seen on the explorations board.", from: { source: "Strata · explorations" } }) });
console.log("· dashboard: four threads across the stages, one for tomorrow morning, and two inbox items");

// drill history in the shapes the app emits, so the decks' progress pips have something to show
const drill = async (boardId, slug, seen, done) => {
  let cards = [];
  try { cards = (await j(`/api/decks/${slug}`)).cards; } catch { return; }
  for (let i = 0; i < Math.min(seen, cards.length); i++) {
    const c = cards[i];
    await j("/api/log", { method: "POST", body: JSON.stringify({ event: "card_show", props: { board: boardId, deck: c.deck, card: c.id, type: c.type } }) });
    if (i < done) {
      const ev = c.type === "mcq" ? "card_answer" : "card_grade";
      const props = { board: boardId, deck: c.deck, card: c.id, type: c.type, ms: 4000 + i * 700 };
      if (c.type === "mcq") props.picked = c.answer ?? 0, props.hit = i % 3 !== 2;
      else props.got = i % 3 !== 2;
      await j("/api/log", { method: "POST", body: JSON.stringify({ event: ev, props }) });
    }
  }
};
// slugs derived like installDeck's genSlug; the drill() fetch keeps a drifted formula from seeding ghosts
const slugOfSection = (sid) => "src-" + sid.replace(/[^a-z0-9]/gi, "").toLowerCase();
if (ch1) await drill(bookBoard.id, slugOfSection(ch1.id), 8, 8);
await drill(slideBoard.id, "aio-lecture-4", 15, 9);
const essayState = await j(`/api/boards/${essayBoard.id}`);
const essaySec = (essayState.sections || []).find((s2) => (s2.resourceId || s2.resource_id) === essayRes.id);
if (essaySec) await drill(essayBoard.id, slugOfSection(essaySec.id), 2, 1);
console.log("· drill history: chapter one done, lecture 4 at 9/25, the essay barely started (seeded)");

// grading enrols nothing, so seed a few keeps or the review strip would be empty
const keepSome = async (slug, n) => {
  const d = await j(`/api/decks/${slug}`).catch(() => null);
  const ids = ((d && d.cards) || []).slice(0, n).map((c) => c.id);
  if (ids.length) await j(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ add: ids }) });
  return ids.length;
};
let keptN = 0;
if (ch1) keptN += await keepSome(slugOfSection(ch1.id), 2);
keptN += await keepSome("aio-lecture-4", 1);
console.log(`· kept: ${keptN} cards on the bench — the review owes these, and only these`);

console.log(`
ready — nine boards. Three carry a format each:
  book    → ${BASE}/?board=${bookBoard.id}
  slides  → ${BASE}/?board=${slideBoard.id}
  essay   → ${BASE}/?board=${essayBoard.id}
…four make the shelf a shelf: a drilled course, a work board, a bare question, an empty one;
and two hold what agents and calls leave: explorations (a live page with notes) and Talks.
  dashboard → ${BASE}/dashboard
`);
