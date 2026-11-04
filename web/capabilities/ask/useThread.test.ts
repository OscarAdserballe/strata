import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardState } from "../../../shared/types/index.ts";

// api.ts reads window and navigator.onLine when it loads
Object.assign(globalThis, { window: new EventTarget() });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
const { StrataAPI } = await import("../../data/api.ts");
const { store } = await import("../../data/store.ts");
const { applyBoardState, boardKey, marksKey } = await import("../../data/entities/boards.ts");
const { sendTurn } = await import("./useThread.ts");

function snapshot(rev: number, marks: { id: string }[]): BoardState {
  return {
    board: { id: "b1", title: "Corporate finance", type: "board" }, rev, notesRev: 1,
    messages: [], resources: [], budget: { usedTokens: 0, targetTokens: 1, over: false }, deck: null, pairs: [],
    notes: "", trees: {}, sections: [], marks, minted: [], mintedEverywhere: [], windowFrom: { "": 0 }, touched: {},
    plan: { purpose: "", groups: [], milestones: [], places: {} },
  } as unknown as BoardState;
}

test("a turn's answer is ordered within the epoch held, so an older read after it cannot step back", async () => {
  applyBoardState(snapshot(10, []), { epoch: "E" });
  store.patch(marksKey("b1"), 12, () => [{ id: "m1" }], { epoch: "E", stamp: 12 });
  const chatStream = StrataAPI.chatStream;
  StrataAPI.chatStream = (async (_id: string, _q: string, cb: { onStart?: (d: unknown) => void; onDone?: (d: unknown) => void }) => {
    cb.onStart?.({ userIdx: 1, replyIdx: 2 });
    cb.onDone?.({ state: snapshot(12, [{ id: "m1" }]), userIdx: 1, replyIdx: 2 });
  }) as typeof StrataAPI.chatStream;
  try { await sendTurn("board:b1", "what does this mean?", { surface: "board", board: "b1" }); }
  finally { StrataAPI.chatStream = chatStream; }
  assert.equal(store.entry(boardKey("b1"))?.epoch, "E", "the answer is read in the epoch held");
  assert.equal(store.entry(marksKey("b1"))?.epoch, "E");
  assert.equal(store.entry(boardKey("b1"))?.rev, 12, "the answer was applied");
  assert.equal(applyBoardState(snapshot(11, []), { epoch: "E" }), false, "the older read is refused");
  assert.deepEqual(store.get(marksKey("b1")), [{ id: "m1" }], "the highlight stays");
});
