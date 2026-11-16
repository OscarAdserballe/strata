import assert from "node:assert/strict";
import { test } from "node:test";
import { fromEditor, softBreaks, toEditor } from "./markdown.ts";

test("a lone newline in plain notes becomes a hard break, lists and paragraphs stay as they are", () => {
  assert.equal(softBreaks("one\ntwo"), "one\\\ntwo");
  assert.equal(softBreaks("- a\n- b"), "- a\n- b");
  assert.equal(softBreaks("intro\n- a"), "intro\n- a");
  assert.equal(softBreaks("one\n\ntwo"), "one\n\ntwo");
  assert.equal(softBreaks("```\nx\ny\n```"), "```\nx\ny\n```");
});

test("the editor's hard breaks are stored as the newline typed", () => {
  assert.equal(fromEditor("First line  \nsecond line\n\n- a"), "First line\nsecond line\n\n- a");
  assert.equal(fromEditor("```\nkeep  \n```"), "```\nkeep  \n```");
  assert.equal(fromEditor("- a\n- b\n\n"), "- a\n- b");
});

test("images go to the editor by URL and come back as img refs", () => {
  const md = "see ![](img:0123456789abcdef)";
  const shown = toEditor(md);
  assert.match(shown, /\]\(\/api\/images\/0123456789abcdef\)/);
  assert.equal(fromEditor(shown), md);
});
