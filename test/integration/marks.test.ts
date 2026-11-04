import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("a mark is made, said, unsaid and removed", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "marks" }) });
  const id = made.board.id;
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "a.md", text: "Alpha beta gamma delta epsilon." }) });

  const { status, body: mk } = await api(`/api/boards/${id}/marks`, {
    method: "POST", body: JSON.stringify({ resourceId: res.id, start: 6, end: 16, quote: "beta gamma" }),
  });
  assert.equal(status, 201);
  assert.equal("state" in mk, false);
  assert.equal(mk.mark.quote, "beta gamma");
  assert.equal(mk.mark.note, null, "a new mark is highlighted, not yet said");

  const { body: said } = await api(`/api/boards/${id}/marks/${mk.id}`, { method: "PATCH", body: JSON.stringify({ note: "the load-bearing bit" }) });
  assert.equal(said.mark.note, "the load-bearing bit");

  const { body: unsaid } = await api(`/api/boards/${id}/marks/${mk.id}`, { method: "PATCH", body: JSON.stringify({ note: "   " }) });
  assert.equal(unsaid.mark.note, null);

  const { body: gone } = await api(`/api/boards/${id}/marks/${mk.id}`, { method: "DELETE" });
  assert.equal(gone.ok, true);
  const { body: after } = await api(`/api/boards/${id}`);
  assert.equal(after.marks.length, 0);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("a mark needs the words it took, and a resource that exists", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "marks guard" }) });
  const id = made.board.id;
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "a.md", text: "some text" }) });
  const { status: empty } = await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify({ resourceId: res.id, quote: "   " }) });
  assert.equal(empty, 400);
  const { status: nores } = await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify({ resourceId: "res-nope", quote: "x" }) });
  assert.equal(nores, 404);
  const { status: nomark } = await api(`/api/boards/${id}/marks/mk-nope`, { method: "PATCH", body: JSON.stringify({ note: "x" }) });
  assert.equal(nomark, 404);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("the reader may name its mark: painted before the save, the name is the id", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "named marks" }) });
  const id = made.board.id;
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "a.md", text: "Alpha beta gamma delta epsilon." }) });
  const mark = { id: "mk-0123456789abcdef", resourceId: res.id, start: 6, end: 16, quote: "beta gamma" };
  const { status, body: mk } = await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify(mark) });
  assert.equal(status, 201);
  assert.equal(mk.id, mark.id);
  assert.equal(mk.mark.id, mark.id);
  const { status: again, body: same } = await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify(mark) });
  assert.equal(again, 200);
  assert.equal(same.mark.quote, "beta gamma");
  const { status: taken } = await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify({ ...mark, start: 0, end: 5, quote: "Alpha" }) });
  assert.equal(taken, 409);
  const { body: renamed } = await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify({ ...mark, id: "../../x", start: 17, end: 22, quote: "delta" }) });
  assert.match(renamed.id, /^mk-[0-9a-f]{8}$/);
  const { body: after } = await api(`/api/boards/${id}`);
  assert.deepEqual(after.marks.map((m: { id: string }) => m.id).sort(), [mark.id, renamed.id].sort());
  const { body: said } = await api(`/api/boards/${id}/marks/${mark.id}`, { method: "PATCH", body: JSON.stringify({ note: "said" }) });
  assert.equal(said.mark.note, "said");
  const { body: gone } = await api(`/api/boards/${id}/marks/${mark.id}`, { method: "DELETE" });
  assert.equal(gone.ok, true);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("a pdf mark keeps its page and its boxes as fractions of it", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "pdf marks" }) });
  const id = made.board.id;
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "a.md", text: "stand-in for a page" }) });
  const { body } = await api(`/api/boards/${id}/marks`, {
    method: "POST",
    body: JSON.stringify({ resourceId: res.id, page: 143, start: 20, end: 31, quote: "on that page", rects: [[0.1, 0.2, 0.3, 0.02], [4, -1, 0.5, 0.02]] }),
  });
  const m = body.mark;
  assert.equal(m.page, 143);
  // out-of-range values are clamped: a rect is applied as a percentage, and 400% would cover the reader
  assert.deepEqual(m.rects[0], [0.1, 0.2, 0.3, 0.02]);
  assert.deepEqual(m.rects[1], [1, 0, 0.5, 0.02]);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("deleting a source takes its marks; deleting the board takes them all", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "marks cascade" }) });
  const id = made.board.id;
  const { body: a } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "a.md", text: "first source" }) });
  const { body: b } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "b.md", text: "second source" }) });
  await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify({ resourceId: a.id, start: 0, end: 5, quote: "first" }) });
  await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify({ resourceId: b.id, start: 0, end: 6, quote: "second" }) });

  const { body: after } = await api(`/api/boards/${id}/resources/${a.id}`, { method: "DELETE" });
  assert.equal(after.state.marks.length, 1, "only the deleted source's marks go");
  assert.equal(after.state.marks[0].quote, "second");

  await api(`/api/boards/${id}`, { method: "DELETE" });
  const { status } = await api(`/api/boards/${id}`);
  assert.equal(status, 404);
});

test("marks travel with the pair that moves to another board", async () => {
  const { body: from } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "marks from" }) });
  const { body: to } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "marks to" }) });
  const { body: res } = await api(`/api/boards/${from.board.id}/resources`, { method: "POST", body: JSON.stringify({ filename: "a.md", text: "travelling source" }) });
  const { body: pair } = await api(`/api/boards/${from.board.id}/pairs`, { method: "POST", body: JSON.stringify({ label: "the reading", resourceId: res.id }) });
  await api(`/api/boards/${from.board.id}/marks`, { method: "POST", body: JSON.stringify({ resourceId: res.id, start: 0, end: 11, quote: "travelling" }) });

  const { body: moved } = await api(`/api/boards/${from.board.id}/pairs/${pair.id}/move`, { method: "POST", body: JSON.stringify({ to: to.board.id }) });
  assert.equal(moved.state.marks.length, 0, "none left on the board it came from");
  assert.equal(moved.destState.marks.length, 1, "and they arrive with the source");
  assert.equal(moved.destState.marks[0].quote, "travelling");

  await api(`/api/boards/${from.board.id}`, { method: "DELETE" });
  await api(`/api/boards/${to.board.id}`, { method: "DELETE" });
});
