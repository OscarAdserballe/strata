import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KINDLE_PROMPT } from "./kindle-prompt.ts";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const tools = read("server/features/agent/tools.ts");
const ops = read("server/features/agent/ops.ts");
const guide = read("server/features/agent/guide.md");

test("the Kindle prompt names only tools, ops and fields the agent server has", () => {
  for (const tool of ["whoami", "get_guide", "request_upload", "get_outline", "apply"]) {
    assert.match(KINDLE_PROMPT, new RegExp(`\\b${tool}\\b`));
    assert.match(tools, new RegExp(`name: "${tool}"`), `${tool} is not a tool`);
  }
  assert.match(KINDLE_PROMPT, /\badd_deck\b/);
  assert.match(ops, /^  add_deck: \{/m);
  assert.match(KINDLE_PROMPT, /origin \{ from: "kindle", ref: /);
  assert.match(tools, /origin: schema\(\{ from:/);
  assert.match(KINDLE_PROMPT, /topic: "uploads"/);
  assert.match(guide, /^## uploads$/m);
  assert.match(KINDLE_PROMPT, /topic: "flashcards"/);
  assert.match(guide, /^## flashcards$/m);
  assert.match(KINDLE_PROMPT, /receipt it ends with as guide/);
  assert.match(ops, /checkReceipt\(o\.guide, "flashcards"\)/);
  assert.match(KINDLE_PROMPT, /4 to 40 consecutive words/);
  assert.match(ops, /4 to 40 consecutive words/);
});
