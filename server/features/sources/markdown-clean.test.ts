import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanImportedMarkdown, type MarkdownCleanCall } from "./markdown-clean.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../../../test/fixtures/markdown", name), "utf8").replace(/\r\n/g, "\n");
const NOISY_NEWSLETTER = fixture("noisy-newsletter.md");
const CLEAN_NEWSLETTER = fixture("clean-newsletter.md");
const NEWSLETTER_CHROME = [0, 1, 6, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74];

test("a full noisy newsletter import becomes the exact clean fixture", async () => {
  let request: Parameters<MarkdownCleanCall>[0] | undefined;
  const call: MarkdownCleanCall = async (opts) => {
    request = opts;
    return { remove: NEWSLETTER_CHROME };
  };

  const cleaned = await cleanImportedMarkdown(NOISY_NEWSLETTER, call);
  const sent = JSON.parse(request?.user ?? "{}") as { blocks?: { id: number; markdown: string }[] };
  assert.equal(sent.blocks?.length, 75);
  assert.equal(sent.blocks?.map((b) => b.markdown).join("\n\n") + "\n", NOISY_NEWSLETTER);
  assert.match(request?.system ?? "", /standalone share buttons/);
  assert.equal(cleaned, CLEAN_NEWSLETTER);
  assert.match(cleaned, /compost-notebook/);
  assert.equal((cleaned.match(/!\[/g) ?? []).length, 4);
  assert.doesNotMatch(cleaned, /Discussion about this post|Ready for more|Start your newsletter/);
});

test("markdown import falls back to the original when cleanup fails", async () => {
  let reported: unknown;
  const original = "# Already clean\n\nKeep every word.\n";
  const cleaned = await cleanImportedMarkdown(original, async () => { throw new Error("offline"); }, (e) => { reported = e; });
  assert.equal(cleaned, original);
  assert.match(String(reported), /offline/);
});

test("markdown import falls back when the model response has no valid removal list", async () => {
  const original = "# Already clean\n";
  assert.equal(await cleanImportedMarkdown(original, async () => ({ remove: "all" })), original);
  assert.equal(await cleanImportedMarkdown(original, async () => ({ remove: [99] })), original);
  assert.equal(await cleanImportedMarkdown(original, async () => ({ nope: "x" })), original);
});

test("a model cannot rewrite or truncate the imported markdown", async () => {
  const original = "# Title\n\nEvery original word remains.\n\nShare\n";
  const cleaned = await cleanImportedMarkdown(original, async () => ({ remove: [2], markdown: "A summary" }));
  assert.equal(cleaned, "# Title\n\nEvery original word remains.\n");
});

test("removing a discussion heading also removes the comments beneath it", async () => {
  const original = "# Article\n\nThe ending.\n\n### Discussion about this post\n\nA reader comment.\n\nReady for more?\n";
  const cleaned = await cleanImportedMarkdown(original, async () => ({ remove: [2] }));
  assert.equal(cleaned, "# Article\n\nThe ending.\n");
});
