import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteAsk, makeDeleting } from "./deleting.ts";

function rig() {
  let leave = (): void => {};
  const said: { text: string; act?: { label: string; run(): void } }[] = [];
  const sent: string[] = [];
  const d = makeDeleting({ onLeave: (fn) => { leave = fn; return () => {}; } }, (text, _ms, act) => { said.push({ text, act }); }, 20);
  return { d, said, sent, leave: () => leave() };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a delete hides the source at once and is sent only once the Undo lapses", async () => {
  const { d, said, sent } = rig();
  d.soon("r1", "Panel data.pdf", () => sent.push("r1"));
  d.soon("r1", "Panel data.pdf", () => sent.push("again"));
  assert.ok(d.ids().has("r1"));
  assert.equal(said[0].text, "Deleted “Panel data.pdf”");
  assert.equal(said[0].act?.label, "Undo");
  assert.deepEqual(sent, []);
  await wait(40);
  assert.deepEqual(sent, ["r1"], "sent once, however often it was asked");
  assert.ok(!d.ids().has("r1"));
});

test("Undo keeps the source and sends nothing; leaving the page sends what still waits", async () => {
  const { d, said, sent, leave } = rig();
  d.soon("r1", "a", () => sent.push("r1"));
  d.soon("r2", "b", () => sent.push("r2"));
  said[0].act!.run();
  assert.ok(!d.has("r1"));
  assert.equal(said.at(-1)!.text, "“a” is back");
  leave();
  assert.deepEqual(sent, ["r2"], "the waiting delete goes as the page does");
  await wait(40);
  assert.deepEqual(sent, ["r2"], "and is not sent twice");
});

test("the confirm says what goes and what stays", () => {
  assert.equal(deleteAsk(), "Delete this source?");
  assert.equal(deleteAsk(1, 0), "Delete this source? 1 highlight or note goes with it.");
  assert.equal(deleteAsk(3, 2), "Delete this source? 3 highlights and notes go with it. 2 kept cards stay in Review.");
  assert.equal(deleteAsk(0, 1), "Delete this source? 1 kept card stays in Review.");
});
