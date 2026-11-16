import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownManager } from "@tiptap/markdown";
import { extensionsFor } from "./schema.ts";

const md = new MarkdownManager({ extensions: extensionsFor(false, "", (id) => `/api/images/${id}`) });
const again = (text: string) => md.serialize(md.parse(text));

test("notes written before the Writer come back out of it as they went in", () => {
  for (const text of [
    "- buy tape\n- fetch poster \n- and glue",
    "Picked under loss.\nNotes on the next line",
    "One paragraph.\n\nAnother.",
    "**bold**, *italic* and ~~gone~~",
    "1. first\n2. second",
    "## Heading\n\nwith `code` and [a link](https://example.com)",
    "> quoted",
    "before\n![](img:0123456789abcdef)\nafter",
  ]) assert.equal(again(text), text);
});

test("a stored image stays a ref to the room, not a URL", () => {
  const doc = md.parse("![](img:0123456789abcdef)");
  assert.equal(JSON.stringify(doc).includes("api/images"), false);
  assert.equal(md.serialize(doc), "![](img:0123456789abcdef)");
});

test("raw HTML in notes stays text, as Review shows it, and is escaped once edited", () => {
  const inline = md.parse("5*3 and <b>raw</b> <!-- a note -->");
  assert.equal(JSON.stringify(inline).includes('"bold"'), false);
  assert.equal(md.serialize(inline), "5\\*3 and &lt;b&gt;raw&lt;/b&gt; &lt;!-- a note --&gt;");
  assert.deepEqual(md.parse("<div>a block</div>").content, [{ type: "paragraph", content: [{ type: "text", text: "<div>a block</div>" }] }]);
});
