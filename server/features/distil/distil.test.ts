import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyAnchor, proseAnchors, anchorLegend, buildTree, buildCards, sanitizeCards,
  normalizeTree, normalizeGlossary, orderByLadder, ladderReport, synthesisRootError, treeToAscii,
  type AnchorInfo, type DistilDeps, type ConceptTree,
} from "./distil.ts";

const pdf18: AnchorInfo = { kind: "pdf", firstPage: 1, lastPage: 18 };

test("a pdf anchor within the file verifies, printed folios beyond it do not", () => {
  assert.equal(verifyAnchor("p. 3", pdf18), null);
  assert.equal(verifyAnchor("pp. 1-2", pdf18), null);
  assert.match(verifyAnchor("pp. 209-210", pdf18) ?? "", /pages 1-18 .* position in the file/);
});

test("a pdf anchor with no page at all is an error — § alone cannot be jumped", () => {
  assert.match(verifyAnchor("§4.2", pdf18) ?? "", /no page position/);
  assert.equal(verifyAnchor("§4.2, p. 12", pdf18), null);
});

test("a section's cards must land inside the section's sheets", () => {
  const ch2: AnchorInfo = { kind: "pdf", firstPage: 18, lastPage: 24 };
  assert.equal(verifyAnchor("§2.3 · p. 22", ch2), null);
  assert.match(verifyAnchor("p. 3", ch2) ?? "", /pages 18-24/);
});

test("an unknown page count checks what it can: a page must exist, its bound cannot", () => {
  const unknown: AnchorInfo = { kind: "pdf", firstPage: 1 };
  assert.equal(verifyAnchor("p. 209", unknown), null);
  assert.match(verifyAnchor("§4.2", unknown) ?? "", /no page position/);
});

const prose: AnchorInfo = { kind: "text", slugs: ["the-early-impact-of-the-prototype-mnemonic-medium", "getting-the-gist"], secs: ["4.2"] };

test("a prose slug resolves exactly or by its words in order — anchorEl's own fallback", () => {
  assert.equal(verifyAnchor("#getting-the-gist", prose), null);
  assert.equal(verifyAnchor("#early-impact", prose), null);
  assert.match(verifyAnchor("#construction-integration", prose) ?? "", /matches no heading/);
});

test("prose resolves §, and @top always lands", () => {
  assert.equal(verifyAnchor("§4.2", prose), null);
  assert.equal(verifyAnchor("@top", prose), null);
});

test("a page cite on structured prose is an error — prose has no pages", () => {
  assert.match(verifyAnchor("pp. 182-183", prose) ?? "", /matches no heading/);
});

test("structureless prose demands the one anchor every text supports: a verbatim quote", () => {
  const bare: AnchorInfo = { kind: "text", slugs: [], secs: [], text: "You and your research. Why do so few scientists make significant contributions?" };
  assert.match(verifyAnchor("Rule 1", bare) ?? "", /no headings.*VERBATIM QUOTE/);
  assert.equal(verifyAnchor('Rule 1 · "why do so few scientists make significant"', bare), null);
  assert.match(verifyAnchor('"words that were never written"', bare) ?? "", /not in the source verbatim/);
});

test("quote matching is word-level: markdown emphasis and quote styles do not break it", () => {
  const bare: AnchorInfo = { kind: "text", slugs: [], secs: [], text: "It is **observable outcome** that\nmatters — really." };
  assert.equal(verifyAnchor('"observable outcome that matters"', bare), null);
  assert.equal(verifyAnchor("“observable outcome that matters”", bare), null);
});

test("a quote also resolves structured prose, and no text at all keeps the old tolerance", () => {
  const withText: AnchorInfo = { ...prose, text: "The gist endures. Everything else fades." };
  assert.equal(verifyAnchor('"the gist endures"', withText), null);
  const bareNoText: AnchorInfo = { kind: "text", slugs: [], secs: [] };
  assert.equal(verifyAnchor("Rule 1", bareNoText), null);
});

test("a transcript anchor must be one of its own stamps", () => {
  const tr: AnchorInfo = { kind: "transcript", timestamps: ["41:20", "1:02:11"] };
  assert.equal(verifyAnchor("@41:20", tr), null);
  assert.match(verifyAnchor("@40:00", tr) ?? "", /not a timestamp/);
  assert.match(verifyAnchor("the middle bit", tr) ?? "", /no timestamp/);
});

test("proseAnchors reads headings, numbered sections and transcript stamps", () => {
  const md = "# The Early Impact\n\n## 4.2 Getting the Gist\n\n[41:20] and then we said…";
  const a = proseAnchors(md);
  assert.deepEqual(a.slugs, ["the-early-impact", "42-getting-the-gist"]);
  assert.deepEqual(a.secs, ["4.2"]);
  assert.deepEqual(a.timestamps, ["41:20"]);
});

const oneNode = (glossary: ConceptTree["glossary"] = []): ConceptTree => ({
  title: "T", question: "", glossary,
  nodes: [{ id: "n1", label: "L", kind: "concept", anchor: "p. 3", questions: ["q"], excerpt: "", children: [] }],
});

const treeJson = (anchor: string) => ({
  title: "T", question: "Q?",
  nodes: [{ label: "The chapter's claims form one explanation", kind: "synthesis", anchor, questions: ["why?"], excerpt: "x", children: [] }],
});

function fakeDeps(replies: unknown[]): { deps: DistilDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      geminiAvailable: true,
      callGeminiJson: async ({ user }) => { calls.push(user); return replies[calls.length - 1]; },
    },
  };
}

test("buildTree sends failing node anchors back once, with the error, and applies a verified fix", async () => {
  const { deps, calls } = fakeDeps([
    treeJson("pp. 209-210"),
    { fixes: [{ ref: "n1", anchor: "pp. 1-2" }] },
  ]);
  const tree = await buildTree({ title: "Kintsch", anchors: pdf18 }, deps);
  assert.equal(tree.nodes[0].anchor, "pp. 1-2");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /cites p\. 209/);
  assert.match(calls[1], /first page is p\. 1/);
});

test("a repair that still does not verify is dropped — the old anchor stays, unpinned", async () => {
  const { deps } = fakeDeps([
    treeJson("pp. 209-210"),
    { fixes: [{ ref: "n1", anchor: "p. 500" }] },
  ]);
  const tree = await buildTree({ title: "Kintsch", anchors: pdf18 }, deps);
  assert.equal(tree.nodes[0].anchor, "pp. 209-210");
});

test("a clean tree costs no extra call", async () => {
  const { deps, calls } = fakeDeps([treeJson("p. 3")]);
  await buildTree({ title: "T", anchors: pdf18 }, deps);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /at or below 50/);
  assert.match(calls[0], /exactly one top-level node/);
  assert.doesNotMatch(calls[0], /TWO NODES THAT GET MISSED/);
});

test("the synthesis root creates L1 and displaces its pillars to L2", () => {
  const tree = normalizeTree({
    title: "T", question: "What does the source explain?", glossary: [],
    nodes: [{
      label: "One explanation joins the source's pillars", kind: "synthesis", anchor: "p. 9",
      questions: ["What is the overall story?", "What boundary matters?"], excerpt: "x",
      children: [
        { label: "The first pillar supports it", kind: "mechanism", anchor: "p. 2", questions: ["How?"], excerpt: "a", children: [] },
        { label: "The second pillar qualifies it", kind: "boundary", anchor: "p. 7", questions: ["When?"], excerpt: "b", children: [] },
      ],
    }],
  }, "fallback");
  assert.equal(synthesisRootError(tree), null);
  assert.equal(tree.nodes[0].id, "n1");
  assert.deepEqual(tree.nodes[0].children.map((n) => n.id), ["n1.1", "n1.2"]);
});

test("new model-built trees retry when the synthesis contract is missing", async () => {
  const invalid = { title: "T", question: "Q?", nodes: [
    { label: "Pillar one", kind: "concept", anchor: "p. 1", questions: ["Q1?"], excerpt: "", children: [] },
    { label: "Pillar two", kind: "concept", anchor: "p. 2", questions: ["Q2?"], excerpt: "", children: [] },
  ] };
  const { deps, calls } = fakeDeps([invalid, treeJson("p. 3")]);
  const tree = await buildTree({ title: "T" }, deps);
  assert.equal(calls.length, 2);
  assert.equal(tree.nodes[0].kind, "synthesis");
});

test("the synthesis contract rejects missing and overloaded root questions", () => {
  const tree = normalizeTree(treeJson("p. 3"), "T");
  tree.nodes[0].questions = [];
  assert.match(synthesisRootError(tree) ?? "", /needs 1-3 questions/);
  tree.nodes[0].questions = ["1", "2", "3", "4"];
  assert.match(synthesisRootError(tree) ?? "", /got 4/);
});

test("generated decks have a mechanical fifty-card ceiling", async () => {
  const tree = oneNode();
  const raw = Array.from({ length: 60 }, (_x, i) => ({
    node: "n1", asks: ["n1#1"], front: `F${i}`, back: `B${i}`,
  }));
  const { deps, calls } = fakeDeps([{ cards: raw }]);
  const cards = await buildCards({ title: "T", tree }, deps);
  assert.equal(cards.length, 50);
  assert.match(calls[0], /no more than 50 cards/i);
});

test("buildCards places each card by its quote, sends a quote that doesn't compile back, and keeps no card it can't place", async () => {
  const tree = oneNode();
  const text = "Prices sit above marginal cost in both. They move together in both, and nothing separates them.";
  const { deps, calls } = fakeDeps([
    { cards: [
      { node: "n1", asks: ["n1#1"], quote: "Prices sit above marginal cost in both", front: "F1", back: "B1" },
      { node: "n1", asks: ["n1#1"], quote: "they move in lockstep", front: "F2", back: "B2" },
      { node: "n1", asks: ["n1#1"], quote: "words that were never written down", front: "F3", back: "B3" },
    ] },
    { fixes: [{ ref: "2", quote: "They move together in both" }] },
    { fixes: [] },
  ]);
  const cards = await buildCards({ title: "T", tree, text, anchors: { kind: "text", text } }, deps);
  assert.deepEqual(cards.map((c) => c.source), ['quote: "Prices sit above marginal cost in both"', 'quote: "They move together in both"']);
  assert.ok(cards.every((c) => !("quote" in c)));
  assert.equal(calls.length, 3);
  assert.match(calls[1], /ref 2 .*not in the source verbatim/);
});

test("on a PDF a card's quote compiles to its page", async () => {
  const pages = ["Cover", "The obvious response is to look for the fingerprints of coordination."];
  const { deps } = fakeDeps([{ cards: [{ node: "n1", asks: ["n1#1"], quote: "look for the fingerprints of coordination", front: "F", back: "B" }] }]);
  const cards = await buildCards({ title: "T", tree: oneNode(), anchors: { kind: "pdf", pages, firstPage: 1, lastPage: 2 } }, deps);
  assert.equal(cards[0].source, 'p. 2 · quote: "look for the fingerprints of coordination"');
});

test("a deck none of whose quotes compile fails, saying why", async () => {
  const { deps } = fakeDeps([{ cards: [{ node: "n1", asks: ["n1#1"], quote: "nothing like the source at all", front: "F", back: "B" }] }, { fixes: [] }, { fixes: [] }]);
  await assert.rejects(buildCards({ title: "T", tree: oneNode(), anchors: { kind: "text", text: "Some other words entirely, here." } }, deps), /no card's quote is in the source/);
});

test("without AnchorInfo nothing changes — old callers get the old behaviour", async () => {
  const { deps, calls } = fakeDeps([treeJson("pp. 209-210")]);
  const tree = await buildTree({ title: "T" }, deps);
  assert.equal(tree.nodes[0].anchor, "pp. 209-210");
  assert.equal(calls.length, 1);
});

test("the sanitizer keeps the ladder fields and accepts only front/back cards", () => {
  const tree = oneNode();
  const cards = sanitizeCards([
    { node: "n1", front: "F", back: "B", introduces: "intensive form", uses: [] },
    { node: "n1", front: "F2", back: "B2", introduces: "", uses: ["intensive form"] },
    { node: "n1", type: "mcq", stem: "S", options: ["a", "b"], correct: 0, introduces: "break-even investment", uses: ["intensive form"] },
  ], tree);
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.type === "flashcard"));
  assert.equal(cards[0].introduces, "intensive form");
  assert.deepEqual(cards[1].uses, ["intensive form"]);
});

test("a deck that says nothing about vocabulary still parses — the fields default empty", () => {
  const tree = oneNode();
  const cards = sanitizeCards([{ node: "n1", type: "flashcard", front: "F", back: "B" }], tree);
  assert.equal(cards[0].introduces, "");
  assert.deepEqual(cards[0].uses, []);
});

test("the glossary dedupes case-insensitively and keeps the first position — order is dependency order", () => {
  const g = normalizeGlossary([
    { term: "Calvo pricing", kernel: "a fixed probability of resetting a price", anchor: "p. 4" },
    { term: "output gap", kernel: "output minus its natural level", anchor: "p. 6" },
    { term: "Calvo Pricing", kernel: "said again, differently", anchor: "p. 9" },
    { term: "  ", kernel: "nameless", anchor: "" },
  ]);
  assert.deepEqual(g.map((x) => x.term), ["Calvo pricing", "output gap"]);
  assert.match(g[0].kernel, /fixed probability/);
});

test("a tree from before the glossary existed parses to an empty one, and nothing downstream cares", () => {
  assert.deepEqual(normalizeGlossary(undefined), []);
  const cards = sanitizeCards([{ node: "n1", type: "flashcard", front: "F", back: "B" }], oneNode());
  assert.equal(cards.length, 1);
  assert.deepEqual(ladderReport(oneNode(), cards), { terms: 0, defined: 0, missing: [], undefined_: [] });
});

test("definition cards are hoisted to the front, in the glossary's order, whatever order the model wrote them", () => {
  const tree = oneNode([
    { term: "steady state", kernel: "where the state variable stops moving", anchor: "p. 3" },
    { term: "golden rule", kernel: "the capital stock that maximises steady-state consumption", anchor: "p. 7" },
  ]);
  const cards = sanitizeCards([
    { node: "n1", type: "flashcard", front: "Why does s not raise long-run growth?", back: "B", uses: ["steady state"] },
    { node: "n1", type: "flashcard", front: "What is the golden rule?", back: "B", introduces: "golden rule" },
    { node: "n1", type: "flashcard", front: "What is the steady state?", back: "B", introduces: "steady state" },
  ], tree);
  // the glossary's order, not the model's — dependency order is the one fact we cannot recompute
  assert.deepEqual(cards.map((c) => c.introduces), ["steady state", "golden rule", ""]);
  assert.deepEqual(ladderReport(tree, cards).undefined_, []);
});

test("a second card naming a term is not a second definition — only the first is hoisted", () => {
  const tree = oneNode([{ term: "output gap", kernel: "output minus its natural level", anchor: "p. 6" }]);
  const cards = sanitizeCards([
    { node: "n1", type: "flashcard", front: "What is the output gap?", back: "kernel", introduces: "output gap" },
    { node: "n1", type: "flashcard", front: "Why is it central?", back: "B", introduces: "output gap" },
  ], tree);
  assert.equal(cards[0].front, "What is the output gap?");
  assert.equal(cards.length, 2);
});

test("a term the glossary asked for and the deck never defined is reported, not swallowed", () => {
  const tree = oneNode([
    { term: "steady state", kernel: "where the state variable stops moving", anchor: "p. 3" },
    { term: "saddle path", kernel: "the one trajectory that reaches the steady state", anchor: "p. 9" },
  ]);
  const cards = sanitizeCards([
    { node: "n1", type: "flashcard", front: "What is the steady state?", back: "B", introduces: "steady state" },
    { node: "n1", front: "Why is the saddle path unique?", back: "B", uses: ["saddle path"] },
  ], tree);
  const r = ladderReport(tree, cards);
  assert.deepEqual(r, { terms: 2, defined: 1, missing: ["saddle path"], undefined_: ["saddle path"] });
});

test("the ladder is read in the order the one plain deck is met", () => {
  const tree = oneNode();
  const cards = [
    { type: "flashcard", front: "F", back: "B", uses: ["Bellman equation"] },
    { type: "flashcard", front: "What is the Bellman equation?", back: "B", introduces: "Bellman equation" },
  ];
  assert.deepEqual(ladderReport(tree, cards).undefined_, ["Bellman equation"]);
});

test("orderByLadder leaves a deck with no glossary exactly as it found it", () => {
  const cards = [{ type: "flashcard", front: "A" }, { type: "flashcard", front: "B" }];
  assert.deepEqual(orderByLadder(cards, []).map((c) => c.front), ["A", "B"]);
});

test("the ascii tree shows the vocabulary — the surface you correct is the surface you read", () => {
  const tree = oneNode([{ term: "break-even investment", kernel: "the investment that just holds k constant", anchor: "p. 5" }]);
  const ascii = treeToAscii(tree);
  assert.match(ascii, /vocabulary \(1\)/);
  assert.match(ascii, /break-even investment — the investment that just holds k constant/);
  assert.match(ascii, /p\. 5/);
});

test("the legend tells a pdf repair the file's real extent", () => {
  assert.match(anchorLegend(pdf18), /pages 1-18 of the file/);
  assert.match(anchorLegend(prose), /#getting-the-gist/);
  assert.match(anchorLegend(prose), /§4\.2/);
});

test("the legend for headingless prose asks for a verbatim quote", () => {
  assert.match(anchorLegend({ kind: "text", slugs: [], secs: [], text: "…" }), /no headings.*VERBATIM QUOTE/);
});
