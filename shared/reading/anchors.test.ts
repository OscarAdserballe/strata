import assert from "node:assert/strict";
import test from "node:test";
import { anchorOf, anchorLabel, quoteAnchor, passageBlock, passageIndex, inferSourceAnchor } from "./anchors.ts";
import { verifyAnchor } from "../../server/features/distil/distil.ts";

test("all reader anchor kinds expose a navigation label, including blog headings and quotes", () => {
  for (const [kind, source] of [["pdf", "p. 12"], ["transcript", "@41:20"], ["text", "#the-tape"], ["text", "§4.2"], ["text", '"a passage that matters"'], ["text", "@top"]])
    assert.ok(anchorLabel(kind, anchorOf({ source })), source);
  assert.equal(anchorLabel("text", anchorOf({ source: "somewhere in the article" })), null);
});

test("passages match across blocks, Markdown links, Unicode and layout differences", () => {
  assert.equal(passageBlock(["Before.", "Café **returns** on a", "[portfolio](https://example.com) are uncertain."], "café returns on a portfolio are uncertain"), 1);
  assert.equal(passageBlock(["We value 数据 and naïve predictions."], "数据 and naïve predictions"), 0);
  assert.equal(passageBlock(["The secret sauce is secret."], "sec"), null);
  assert.equal(passageBlock(["Repeated text.", "Repeated text."], "repeated text"), null);
  assert.equal(passageBlock(["A paragraph."], "a completely different passage"), null);
});

test("encoded quotes preserve embedded quotes and do not invent page or timestamp anchors", () => {
  const quote = 'He calls page 12 "the start" at 41:20.\n' + "a long quotation ".repeat(30);
  const anchor = anchorOf({ source: quoteAnchor(quote) });
  assert.equal(anchor.quote, quote.trim());
  assert.equal(anchor.slide, null);
  assert.equal(anchor.ts, null);
  assert.equal(anchorOf({ source: "p. 3 · " + quoteAnchor(quote) }).slide, 3);
});

test("literal pasted passages resolve to physical PDF pages or searchable prose/transcript quotes", () => {
  const passage = "Diversification reduces the risk of individual investments.";
  const pdf = inferSourceAnchor("pdf", "", ["Cover", passage], [passage]);
  assert.equal(anchorOf({ source: pdf }).slide, 2);
  for (const kind of ["text", "transcript"]) {
    const text = "# An article\n\n[0:00] " + passage;
    const source = inferSourceAnchor(kind, text, [], [passage]);
    assert.ok(source);
    assert.equal(verifyAnchor(source, { kind, text, timestamps: ["0:00"] }), null);
  }
  assert.equal(inferSourceAnchor("text", passage, [], ["an unrelated explanation of the world"]), null);
  assert.equal(inferSourceAnchor("text", passage + "\n" + passage, [], [passage]), null);
});

test("one passage index answers every quote the way a fresh search would", () => {
  const blocks = ["Before.", "Café **returns** on a", "[portfolio](https://example.com) are uncertain.", "Repeated text.", "Repeated text.", "We value 数据 and naïve predictions."];
  const index = passageIndex(blocks);
  for (const quote of ["café returns on a portfolio are uncertain", "repeated text", "数据 and naïve predictions", "sec", "", "a completely different passage", "Before"])
    assert.equal(index.find(quote), passageBlock(blocks, quote), quote);
  assert.equal(index.find("café returns on a portfolio are uncertain"), 1);
  assert.equal(passageIndex([]).find("anything at all"), null);
});

test("anchorOf parses the first page/slide, section, timestamp or slug", () => {
  assert.equal(anchorOf({ source: "Lecture 1, slides 5-6" }).slide, 5);
  assert.equal(anchorOf({ source: "p. 12" }).slide, 12);
  assert.equal(anchorOf({ source: "§4.2 the argument" }).sec, "4.2");
  assert.equal(anchorOf({ source: "@41:20" }).ts, "41:20");
  assert.equal(anchorOf({ source: "#Early-Impact" }).slug, "early-impact");
  assert.equal(anchorOf({ source: "@top" }).top, true);
});

test("anchorOf parses a verbatim quote, straight or curly, and keeps the human label", () => {
  assert.equal(anchorOf({ source: 'Rule 1 · "do not learn if you do not understand"' }).quote, "do not learn if you do not understand");
  assert.equal(anchorOf({ source: "“the exact words, copied”" }).quote, "the exact words, copied");
  assert.equal(anchorOf({ source: 'a "short" aside' }).quote, null);   // under 6 chars is punctuation, not an anchor
});

test("no anchor in the source resolves to nothing — no pin, honestly", () => {
  const a = anchorOf({ source: "somewhere in the middle" });
  assert.deepEqual([a.slide, a.sec, a.ts, a.slug, a.quote, a.top], [null, null, null, null, null, false]);
});

