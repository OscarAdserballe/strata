import { test } from "node:test";
import assert from "node:assert/strict";

type Win = EventTarget & { __strataPending?: number; __strataSent?: number };
// api.ts listens on window when it loads, so the stand-in has to exist before the import
const win: Win = new EventTarget();
Object.assign(globalThis, { window: win });
// Node's navigator has no onLine, which reads as offline and would refuse every write.
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
// every fetch waits until the test answers it, in the order they were made
const answers: ((r: Response) => void)[] = [];
globalThis.fetch = (() => new Promise<Response>((resolve) => { answers.push(resolve); })) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settledOnce = () => new Promise<void>((resolve) => win.addEventListener("strata:settled", () => resolve(), { once: true }));

const { api, StrataAPI } = await import("./api.ts");
const { notesSender } = await import("./entities/notes.ts");

test("a read is counted while it is out, and settled fires after its caller has had the answer", async () => {
  const order: string[] = [];
  const settled = settledOnce().then(() => order.push("settled"));
  const read = api<{ n: number }>("/api/one").then((v) => { order.push("caller"); return v; });
  assert.equal(win.__strataPending, 1, "the read is out");
  const sent = win.__strataSent!;
  answers.shift()!(json({ n: 1 }));
  assert.deepEqual(await read, { n: 1 });
  assert.equal(win.__strataPending, 0, "…and back");
  await settled;
  assert.deepEqual(order, ["caller", "settled"], "a suite that wakes on settled finds the answer already applied");
  assert.equal(win.__strataSent, sent, "sent counts requests that left, not answers");
});

test("two out at once: settled waits for the last, and a failure is uncounted like a success", async () => {
  let fired = 0;
  const count = () => { fired++; };
  win.addEventListener("strata:settled", count);
  try {
    const before = win.__strataSent ?? 0;        // unset until the first request leaves
    const read = api("/api/two");
    const write = api("/api/three", { method: "POST", body: "{}" }).catch((e: Error & { status?: number }) => e);
    assert.equal(win.__strataPending, 2);
    assert.equal(win.__strataSent, before + 2);
    answers.shift()!(json({ ok: true }));
    await read;
    assert.equal(win.__strataPending, 1, "one still out");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(fired, 0, "nothing settles while a request is still out");
    answers.shift()!(json({ error: "no such thing" }, 404));
    const err = await write;
    assert.equal((err as { status?: number }).status, 404);
    assert.equal(win.__strataPending, 0, "a refused request leaves the count like any other");
    await settledOnce();
  } finally { win.removeEventListener("strata:settled", count); }
});

test("the writes that skip api() are counted too: the save path's and the chat streams", async () => {
  const notes = notesSender()("b-1", "a running log");
  assert.ok(win.__strataPending! >= 1, "the notes save is out");
  await new Promise((r) => setImmediate(r));
  answers.shift()!(new Response(null, { status: 204 }));
  await notes;
  await new Promise((r) => setImmediate(r));
  assert.equal(win.__strataPending, 0);

  const turn = StrataAPI.cardChatStream({ card: "c", course: "k", message: "why?", rung: 1 });
  assert.equal(win.__strataPending, 1, "a streamed turn is out until its stream ends");
  answers.shift()!(new Response("event: done\ndata: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  await turn;
  assert.equal(win.__strataPending, 0);
});
