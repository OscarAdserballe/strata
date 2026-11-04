import { test } from "node:test";
import assert from "node:assert/strict";
import { compileAnchor, compileQuote, foldWords, quoteAnchor, readableQuote, quoteOfAnchor, widenQuote } from "./compile-quote.ts";

const essay = "# The problem\n\nPrices sit above **marginal cost** in both. They move together in both.\n\nNo amount of *price data alone* will [separate](https://x.org/a) them.";

test("a quote resolves where its words occur once, through markup, case and punctuation", () => {
  const c = compileQuote("prices sit above marginal cost in both", { text: essay });
  assert.ok(c.ok);
  assert.equal(essay.slice(c.at.start, c.at.end), "Prices sit above **marginal cost** in both");
  const link = compileQuote("No amount of price data alone will separate them", { text: essay });
  assert.ok(link.ok, "a link's target is not words");
});

test("a quote that is not verbatim, or occurs twice, or is too short, does not compile, and says why", () => {
  const miss = compileQuote("Prices sit well above marginal cost", { text: essay });
  assert.ok(!miss.ok && /not in the source verbatim/.test(miss.error));
  const twice = compileQuote("together in both", { text: essay + " They move together in both." });
  assert.ok(!twice.ok && /words/.test(twice.error), "three words is too short");
  const twice4 = compileQuote("They move together in both", { text: essay + " They move together in both." });
  assert.ok(!twice4.ok && /occurs 2 times/.test(twice4.error));
  assert.ok(!compileQuote("", { text: essay }).ok);
});

test("on a PDF a quote compiles to its page, within the passage's pages, across a hyphenated line break", () => {
  const pages = ["Title page", "The identi-\nfication problem is the central one.", "Elsewhere: the identification problem is the central one."];
  const c = compileQuote("The identification problem is the central one", { pages, firstPage: 2, lastPage: 2 });
  assert.ok(c.ok);
  assert.equal(c.at.page, 2);
  assert.equal(pages[1].slice(c.at.start, c.at.end), "The identi-\nfication problem is the central one");
  const all = compileQuote("the identification problem is the central one", { pages });
  assert.ok(!all.ok && /occurs 2 times \(pp\. 2, 3\)/.test(all.error));
  const out = compileQuote("Elsewhere: the identification problem is", { pages, firstPage: 2, lastPage: 2 });
  assert.ok(!out.ok && /outside this passage/.test(out.error));
});

test("ligatures and curly quotes fold to plain words", () => {
  assert.equal(foldWords("ﬁnal “word”").s, " final word ");
  assert.ok(compileQuote("the final word on the matter", { text: "This is the ﬁnal word on the matter." }).ok);
});

test("an anchor is stored with its page and read back; anything but a quote does not compile", () => {
  const a = quoteAnchor("The identification problem is the central one", { page: 2, start: 0, end: 1 });
  assert.equal(a, 'p. 2 · quote: "The identification problem is the central one"');
  assert.deepEqual(quoteOfAnchor(a), { quote: "The identification problem is the central one", page: 2 });
  assert.equal(quoteOfAnchor("§2.1"), null);
  const sec = compileAnchor("§2.1", { text: essay });
  assert.ok(!sec.ok && /not a quote/.test(sec.error));
  assert.ok(!compileAnchor("", { text: essay }).ok);
});

test("words picked that occur elsewhere too grow until they are the only ones", () => {
  const text = "They move together in both. Prices sit above cost in both. They move together in both markets, which matters.";
  const at = text.lastIndexOf("together in both");
  const w = widenQuote(text, at, at + "together in both".length);
  assert.ok(w);
  assert.ok(compileQuote(w.quote, { text }).ok, w.quote);
  assert.ok(w.start <= at && w.end >= at + 16);
  assert.match(w.quote, /together in both markets/);
  const cut = text.indexOf("rices sit above");
  assert.equal(widenQuote(text, cut, cut + "rices sit above co".length)?.quote, "Prices sit above cost", "a selection inside words is held to whole words");
  const block = Array.from({ length: 45 }, (_x, i) => "w" + i).join(" ");
  assert.equal(widenQuote(block + ". " + block, 10, 20), null, "a passage repeated word for word has nothing unique within forty words");
});

test("a passage longer than a quote is placed by its opening words", () => {
  const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + ".";
  const w = widenQuote(text, 0, text.length);
  assert.ok(w);
  assert.equal(w.quote.split(" ").length, 25);
  assert.ok(compileQuote(w.quote, { text }).ok);
});

test("a quote copied from markdown reads without its markup, and keeps its words", () => {
  assert.equal(readableQuote("price data alone* will"), "price data alone will");
  assert.equal(readableQuote("see [the tape](#the-tape) and snake_case"), "see the tape and snake_case");
  assert.equal(readableQuote("**bold** and snake_case and other_thing"), "bold and snake_case and other_thing");
});

test("a PDF anchor compiles on the page it names, though its words recur on other pages", () => {
  const pages = ["Front matter.", "Running head. The same paragraph again and again.", "Running head. The same paragraph again and again."];
  assert.ok(!compileQuote("The same paragraph again and again", { pages }).ok);
  const placed = compileAnchor(`p. 3 · quote: "The same paragraph again and again"`, { pages });
  assert.ok(placed.ok && placed.at.page === 3);
  const off = compileAnchor(`p. 1 · quote: "The same paragraph again and again"`, { pages });
  assert.ok(!off.ok && /not on p\. 1/.test(off.error), JSON.stringify(off));
  assert.ok(!compileAnchor(`p. 3 · quote: "The same paragraph again and again"`, { pages, firstPage: 1, lastPage: 2 }).ok);
});

test("words a PDF's extraction split apart are still the same words, both ways round", () => {
  const extracted = { pages: ["They show little improvement after the fi rst round of interaction, su ffi ciently fea- tures apart."] };
  assert.ok(compileQuote("little improvement after the first round", extracted).ok);
  assert.ok(compileQuote("su ffi ciently fea- tures apart", extracted).ok);
  assert.ok(compileQuote("interaction, sufficiently features apart", extracted).ok);
  const rendered = { pages: ["They show little improvement after the first round of interaction."] };
  assert.ok(compileQuote("after the fi rst round of", rendered).ok);
  // blind to spaces only from whole word to whole word
  assert.ok(!compileQuote("how little improvement after", { text: "They show little improvement after it." }).ok);
});

test("accents, letters outside the basic plane and deeply indented line breaks fold to the same words", () => {
  assert.ok(compileQuote("The intercept estimator is \u0233 minus", { text: "So: the intercept estimator is y\u0304 minus the rest." }).ok);
  assert.ok(compileQuote("cost \u03c4 acts as a buffer", { text: "Transportation cost \u{1d70f} acts as a buffer against price competition." }).ok);
  assert.ok(compileQuote("minutes before arriving at class", { text: "Come 30 minutes be-\n                                 fore arriving at class." }).ok);
  assert.ok(compileQuote("the log-likelihood of the model", { text: "Maximise the log-\nlikelihood of the model." }).ok);
});

test("a transcript's [music] and timestamps are no words", () => {
  const text = "[0:00] so the first thing [Music] we do is measure [1:02:03] the load";
  assert.ok(compileQuote("so the first thing we do is measure the load", { text }).ok);
  assert.ok(compileQuote("thing [music] we do is", { text }).ok);
});
