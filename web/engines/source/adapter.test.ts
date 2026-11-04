import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorOf } from "../../../shared/reading/anchors.ts";
import { sourceAdapters } from "./adapter.ts";

const host = (asked: unknown[] = []) => ({
  scroller: () => null,
  ensureDrawn: () => {},
  revealLive: async (q: string | null, slug: string | null) => { asked.push([q, slug]); return q === "found"; },
  layersLive: () => {},
  proseDoc: () => null,
  pdfText: () => null,
});

test("a live page is asked through the bridge, by its quote and slug", async () => {
  const asked: unknown[] = [];
  const html = sourceAdapters(host(asked))("html");
  assert.equal(await html.reveal(anchorOf({ source: 'quote: "found"' })), true);
  assert.equal(await html.reveal(anchorOf({ source: "#a-heading" })), false);
  assert.deepEqual(asked, [["found", null], [null, "a-heading"]]);
  assert.equal(html.blockOf(anchorOf({ source: 'quote: "found"' })), null);
});

test("a source drawn in the reader finds nothing without a scroller, and says so", async () => {
  const md = sourceAdapters(host())("text");
  assert.equal(md.blockOf(anchorOf({ source: "§2.1" })), null);
  assert.equal(md.kind, "text");
});

test("adapters are made once per kind", () => {
  const of = sourceAdapters(host());
  assert.equal(of("pdf"), of("pdf"));
  assert.notEqual(of("pdf"), of("html"));
});


test("a live page draws its own layers: they cross the sandbox whole, with what is done in them", () => {
  const sent: unknown[] = [];
  const html = sourceAdapters({ ...host(), layersLive: (items, on) => { sent.push(items.length); on.edit("mk-1"); } })("html");
  let edited = "";
  html.drawLayers([{ id: "mk-1", kind: "note", quote: "q", text: "t", editing: false, replies: [], anchor: { start: 0, end: 1, quote: "q" } }],
    { edit: (id) => { edited = id; }, leave() {}, remove() {}, reply() {}, show() {}, later() {}, grade() {}, keep() {}, discard() {}, ask() {}, capture() {} });
  assert.deepEqual(sent, [1]);
  assert.equal(edited, "mk-1");
});
