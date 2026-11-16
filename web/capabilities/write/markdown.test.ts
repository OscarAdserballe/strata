import { test } from "node:test";
import assert from "node:assert/strict";
import { converter } from "./markdown.ts";

const again = (md: string) => converter().serialize(converter().parse(md));

test("plain text, lists and the room's image refs come back exactly as stored", () => {
  for (const md of [
    "plain line", "line one\nline two", "para one\n\npara two", "trailing space ", "  leading",
    "- buy tape\n- fetch poster \n- glue\n\nThen hang it.", "- a\n- b", "1. one\n2. two", "- a\n  - nested",
    "- [ ] open\n- [x] done",
    "snake_case and file_name.ts and 2 * 3", "a <b>tag</b> & R&D", "see https://example.com/a_b_c here",
    "**bold** and *italic*", "[link](https://example.com)", "> quote", "# head", "`co_de` and *it*",
    "text\n\n![](img:0123456789abcdef)\n\nmore", "",
  ]) assert.equal(again(md), md, JSON.stringify(md));
});

test("a character that would read as syntax is escaped, so it stays a character", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "*not italic* and _not_ either" }] }] };
  const md = converter().serialize(doc);
  assert.deepEqual(converter().parse(md), converter().parse(converter().serialize(converter().parse(md))));
  assert.equal(md, "\\*not italic\\* and \\_not\\_ either");
});

test("bold, italic and a list written in the editor are stored as plain Markdown", () => {
  const doc = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "a " }, { type: "text", text: "bold", marks: [{ type: "bold" }] }, { type: "text", text: " word" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one", marks: [{ type: "italic" }] }] }] }] },
  ] };
  assert.equal(converter().serialize(doc), "a **bold** word\n\n- *one*");
});
