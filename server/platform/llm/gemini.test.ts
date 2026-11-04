// Gemini discounts the longest byte-identical prefix, so stable context leads and the current turn is last.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContents, type GeminiContext, type GeminiTurn } from "./gemini.ts";

test("the next turn's request begins with this turn's, byte for byte, up to this turn's question", () => {
  const context: GeminiContext = { files: [{ mimeType: "application/pdf", data: "JVBERi0xLjQK" }], text: "p. 1: duration hedging" };
  const history: GeminiTurn[] = [{ role: "user", text: "what is DV01?" }, { role: "model", text: "the price change for 1bp" }];
  const now = buildContents({ context, history, user: "WHERE: p. 3\nwhy does convexity break it?" });
  const next = buildContents({ context, history: [...history, { role: "user", text: "WHERE: p. 3\nwhy does convexity break it?" }, { role: "model", text: "large moves" }],
    user: "WHERE: p. 4\nand a twist?" });
  const stable = JSON.stringify(now.slice(0, -1));
  assert.ok(JSON.stringify(next).startsWith(stable.slice(0, -1)), "the context and history did not lead the next request unchanged");
  assert.deepEqual(next.at(-1), { role: "user", parts: [{ text: "WHERE: p. 4\nand a twist?" }] }, "the turn that changes is not last");
  assert.deepEqual(now[0], { role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } }, { text: "p. 1: duration hedging" }] },
    "the standing document is not first");
});
