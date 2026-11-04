import { test } from "node:test";
import assert from "node:assert/strict";
import { mdRender, mdToHtml } from "./render.ts";
import { plainQuote, slugOf } from "../../../shared/reading/prose-slugs.ts";

test("a paragraph renders with data-b and its map covers every rendered character", () => {
  const { html, maps } = mdRender("plain words", false);
  assert.match(html, /^<p data-b="0">plain words<\/p>$/);
  assert.equal(maps.length, 1);
  // one entry per rendered char + one for the block's end
  assert.equal(maps[0].length, "plain words".length + 1);
  assert.equal(maps[0][0], 0);
  assert.equal(maps[0][6], 6);
});

test("headings carry data-sec when numbered, and always their slug", () => {
  const { html } = mdRender("## 4.2 The identification problem", false);
  assert.match(html, /data-sec="4\.2"/);
  assert.match(html, /data-slug="42-the-identification-problem"/);
  const plain = mdToHtml("# The Early Impact", false);
  assert.match(plain, /data-slug="the-early-impact"/);
  assert.doesNotMatch(plain, /data-sec/);
});

test("a heading numbered without a dot is a section too", () => {
  const { html } = mdRender("## 1 What the data cannot tell you", false);
  assert.match(html, /data-sec="1"/);
  assert.match(html, /<span class="num">1<\/span>/);
});

test("a heading that merely opens with a year is not a section", () => {
  const { html } = mdRender("## 1984 and the surveillance state", false);
  assert.doesNotMatch(html, /data-sec/);
});

test("a transcript paragraph's opening timestamp becomes data-ts", () => {
  const { html } = mdRender("[41:20] the speaker turns to coordination", false);
  assert.match(html, /data-ts="41:20"/);
  assert.match(html, /<span class="ts">/);
});

test("breaks mode keeps typed newlines; source mode reflows a hard-wrapped paragraph", () => {
  assert.match(mdToHtml("one\ntwo", true), /one<br\/>two/);
  assert.match(mdToHtml("one\ntwo", false), /one two/);
});

test("``` fences render as code in breaks mode only", () => {
  assert.match(mdToHtml("```\nconst x = 1;\n```", true), /<pre data-b="0"><code>const x = 1;<\/code><\/pre>/);
  assert.doesNotMatch(mdToHtml("```\nconst x = 1;\n```", false), /<pre/);
});

test("emphasis opens only at a word boundary — snake_case and 3*4 stay literal", () => {
  assert.match(mdToHtml("a *word* here", false), /<em>word<\/em>/);
  assert.match(mdToHtml("snake_case_name stays", false), /snake_case_name/);
  assert.match(mdToHtml("3*4 = 12 and 2*3 too", false), /3\*4/);
});

test("links render safely: only http(s) urls become anchors, quotes are encoded", () => {
  assert.match(mdToHtml("[home](https://example.com)", false), /<a href="https:\/\/example\.com" target="_blank" rel="noopener">home<\/a>/);
  assert.doesNotMatch(mdToHtml("[x](javascript:alert(1))", false), /<a /);
  assert.match(mdToHtml('[x](https://e.com/"onmouseover=)', false), /%22/);
});

test("a wiki link with parens in the url keeps its tail", () => {
  assert.match(mdToHtml("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))", false), /Foo_\(bar\)/);
});

test("an imported image renders lazily with its caption and no referrer", () => {
  const h = mdToHtml("![diagram](https://e.com/x.png)", false);
  assert.match(h, /class="media"/);
  assert.match(h, /<img class="media-img" src="https:\/\/e\.com\/x\.png" alt="diagram" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);
  assert.match(h, /class="media-cap">diagram<\/span>/);
  // A captionless image still has a valid block map even though it renders no text.
  const { html, maps } = mdRender("![](https://e.com/x.png)", false);
  assert.match(html, /<img /);
  assert.equal(maps[0].length, 1);
});

test("a linked image loads its image URL and opens the author's target", () => {
  const h = mdToHtml("[![diagram](https://e.com/x.png)](https://e.com/post)", false);
  assert.match(h, /class="media" href="https:\/\/e\.com\/post"/);
  assert.match(h, /src="https:\/\/e\.com\/x\.png"/);
  assert.match(mdToHtml('![a "diagram"](https://e.com/x.png)', false), /alt="a &quot;diagram&quot;"/);
});

test("GIFs render as images, while direct video and audio links get native controls", () => {
  assert.match(mdToHtml("![demo](https://e.com/demo.gif)", false), /<img class="media-img"/);
  const video = mdToHtml("[Demo](https://e.com/demo.mp4?download=1)", false);
  assert.match(video, /<video class="media-video"[^>]* controls preload="metadata" playsinline referrerpolicy="no-referrer"><\/video>/);
  assert.match(video, /class="media-cap" href="https:\/\/e\.com\/demo\.mp4\?download=1"/);
  const audio = mdToHtml("[Listen](https://e.com/talk.mp3)", false);
  assert.match(audio, /<audio class="media-audio"[^>]* controls preload="metadata" referrerpolicy="no-referrer"><\/audio>/);
});

test("the world-class designer article's complete visual set survives rendering", () => {
  const assets = [
    ["f7135ec6-882d-462e-9935-308206a97182_900x900", "gif"],
    ["c1445c00-4834-4a86-ab85-5e53ae87a652_900x528", "gif"],
    ["a3d78ad3-3100-4bf0-b6be-0fc4cfa07987_640x360", "gif"],
    ["bc7e732b-64b8-4538-8b17-82290d34d032_1774x887", "png"],
    ["7b59bdf3-8a82-46d1-94c2-4a1e60ea7cbf_1456x894", "png"],
    ["f37064a7-2853-4314-b175-aa65b8a13f43_1456x876", "png"],
    ["bcda7156-dbbd-4d18-a7fb-4cfc124563bf_1456x876", "png"],
    ["3d880aa5-5e31-45f5-99c4-8055dcb87f4a_640x360", "webp"],
    ["a7245156-8c71-4ecc-9897-5ce76e561faf_640x360", "gif"],
    ["220747d1-f561-405f-a95c-7b05fd64731b_640x360", "gif"],
    ["0e1d6d22-1828-47d5-b2f6-0d88fef90ae2_1456x571", "webp"],
    ["0e7340b1-9a93-4d94-abc6-c6b386f3a36c_1456x449", "png"],
    ["4ca0ce7c-c730-443a-bde3-f62996b43c7d_1456x692", "png"],
    ["25c296a8-ce8c-4633-ac96-2dcbad6d9430_1456x876", "png"],
    ["5e045d71-d5f7-436a-be1f-eb870df24062_1456x1861", "png"],
    ["7e2a6925-7451-4abe-aaa8-bc92823dd69a_1456x399", "gif"],
    ["f4ae7b09-1555-4ade-850c-212cb0d089b2_1456x399", "gif"],
    ["7cd81d80-09c1-4244-9651-43bba85771a4_1456x399", "gif"],
    ["c02123f6-00f8-4063-8463-5050d2649647_1456x399", "gif"],
    ["aa994e2f-caec-40bf-8cc5-8a1ef101dd21_1456x399", "gif"],
    ["2f3bb583-375b-4a12-aa57-64a10bf2d9e7_960x540", "gif"],
    ["dc9186ef-2b04-42a0-a460-8898b0590797_1456x964", "png"],
    ["fdf80ee5-9f43-44e9-93cf-c477a9e49128_1456x964", "png"],
  ];
  const markdown = assets.map(([name, ext]) => `![](https://substack-post-media.s3.amazonaws.com/public/images/${name}.${ext})`).join("\n\n");
  const { html, maps } = mdRender(markdown, false);
  assert.equal((html.match(/<img class="media-img"/g) ?? []).length, 23);
  assert.equal((html.match(/src="[^"]+\.gif"/g) ?? []).length, 11);
  assert.equal((html.match(/src="[^"]+\.png"/g) ?? []).length, 10);
  assert.equal((html.match(/src="[^"]+\.webp"/g) ?? []).length, 2);
  assert.equal(maps.length, 23);
});

test("a non-http image URL stays inert", () => {
  const h = mdToHtml("![diagram](javascript:alert(1))", false);
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h, /href=/);
  assert.match(h, /class="fig-missing">diagram<\/span>/);
});

test("html is escaped — a source cannot inject markup", () => {
  assert.match(mdToHtml("<script>alert(1)</script>", false), /&lt;script&gt;/);
});

test("the map follows a reflowed paragraph back to the right source offsets", () => {
  const src = "alpha\nbeta";
  const { maps } = mdRender(src, false);
  const map = maps[0];
  // rendered "alpha beta": the joining space maps to the newline, beta's b to its source spot
  assert.equal(map[5], 5);                   // the space ← the "\n" at offset 5
  assert.equal(map[6], src.indexOf("beta"));
});

test("plainQuote strips markdown but keeps the words; slugOf survives punctuation", () => {
  assert.equal(plainQuote("**bold** and [link](https://x.y) and `code`"), "bold and link and code");
  assert.equal(slugOf("The Early — Impact, of the *prototype*!"), "the-early-impact-of-the-prototype");
});
