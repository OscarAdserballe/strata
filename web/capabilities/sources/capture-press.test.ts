import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: [join(import.meta.dirname, "Capture.tsx")],
  bundle: true, write: false, format: "esm", logLevel: "error",
});
const C = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel", onLine: true }, configurable: true });
Object.assign(globalThis, { document: { body: {} } });

interface El { type: unknown; props: Record<string, any>; kids: unknown[] }
const Fake = { Fragment: "", createElement: (type: unknown, props: Record<string, any> | null, ...kids: unknown[]): El => ({ type, props: props || {}, kids }) };
function find(n: unknown, ok: (e: El) => boolean): El | null {
  if (Array.isArray(n)) { for (const k of n) { const f = find(k, ok); if (f) return f; } return null; }
  if (!n || typeof n !== "object") return null;
  return ok(n as El) ? (n as El) : find((n as El).kids, ok);
}
const drawn = (r: { cap: unknown }) => C.default({ cap: r.cap, onClose: () => { r.cap = null; }, toast() {} });
const type = (r: { cap: unknown }, value: string) => find(drawn(r), (e) => e.type === "input" || e.type === "textarea")!.props.onChange({ target: { value } });
const pressIt = (r: { cap: unknown }) => find(drawn(r), (e) => e.type === "button" && e.kids.some((k) => k === "fetch it" || k === "add the transcript"))!.props.onClick();
let n = 0;
const fresh = () => `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nLine ${++n}.\n`;

const TALK = "https://www.youtube.com/watch?v=x";
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne line.\n";
type Cap = any;
interface Sent { path: string; key?: string; body?: unknown; answer(r: unknown): void; fail(e: unknown): void }

function room() {
  const r = { cap: null as Cap, added: 0, landed: [] as string[], said: [] as string[], out: [] as Sent[] };
  const wire = (path: string, key?: string, body?: unknown) => new Promise((answer, fail) => { r.out.push({ path, key, body, answer, fail }); });
  C.bind({
    React: Fake, createPortal: (el: unknown) => el,
    api: {
      log() {},
      capture: (id: string, _url: string, key?: string) => wire(`/api/boards/${id}/capture`, key),
      captureFinish: (id: string, body: unknown, key?: string) => wire(`/api/boards/${id}/capture/finish`, key, structuredClone(body)),
    },
    resolve: async (b: string | null) => b ?? "b1",
    set: (next: Cap) => { r.cap = typeof next === "function" ? (r.cap ? next(r.cap) : null) : next; },
    now: () => r.cap,
    added: () => { r.added++; },
    landed: (l: { resourceId: string }, message: string | null) => { r.landed.push(l.resourceId); if (message) r.said.push(message); },
  });
  return r;
}
const settle = () => new Promise((r) => setImmediate(r));
const linkStep = (url: string): Cap => ({ boardId: "b1", step: "url", url, vtt: "", busy: false, error: "", dialog: {} });
const captions = (vtt: string): Cap => ({ boardId: "b1", step: "captions", url: TALK, title: "A talk", author: "", vtt, busy: false, error: "", dialog: {} });
const transcript = { kind: "transcript", resourceId: "r1", cues: 1, state: { board: { id: "b1" } } };

test("a cancelled press's answer leaves the next dialog as it is, and still lands the source", async () => {
  const r = room();
  r.cap = captions(VTT);
  void C.submitCaptions();
  await settle();
  assert.equal(r.out.length, 1);
  r.cap = null;
  const next = captions(`${VTT}Two.\n`);
  r.cap = next;
  void C.submitCaptions();
  await settle();
  assert.equal(r.out.length, 2);
  r.out[0].answer(transcript);
  await settle();
  assert.ok(r.cap, "the first answer closed the dialog opened after it");
  assert.equal(r.cap.dialog, next.dialog);
  assert.equal(r.cap.busy, true, "the next dialog's press is still out");
  assert.equal(r.cap.vtt, next.vtt);
  assert.deepEqual([r.added, r.landed, r.said], [1, ["r1"], ["A talk — 1 cues"]], "the server added the source: it lands, and is told");
  r.out[1].answer({ ...transcript, resourceId: "r2" });
  await settle();
  assert.equal(r.cap, null, "its own answer closes the next dialog");
});

test("a late YouTube answer does not turn the next dialog into a captions step", async () => {
  const r = room();
  r.cap = linkStep(TALK);
  void C.submitUrl();
  await settle();
  r.cap = null;
  const next = linkStep("https://example.org/an-article");
  r.cap = next;
  r.out[0].answer({ kind: "youtube", url: TALK, title: "A talk", ytDlpCommand: "yt-dlp" });
  await settle();
  assert.equal(r.cap, next, "the next dialog is untouched");
  assert.deepEqual([r.added, r.landed, r.said], [0, [], []], "a link step writes nothing, so nothing lands");
  const here = linkStep(TALK);
  r.cap = here;
  void C.submitUrl();
  await settle();
  r.out[1].answer({ kind: "youtube", url: TALK, title: "A talk", ytDlpCommand: "yt-dlp" });
  await settle();
  assert.equal(r.cap.step, "captions");
  assert.equal(r.cap.dialog, here.dialog, "the captions step is the same dialog");
});

test("a late refusal writes nothing into the next dialog while that one's own press is out", async () => {
  const r = room();
  r.cap = captions(VTT);
  void C.submitCaptions();
  await settle();
  r.cap = null;
  r.cap = captions(`${VTT}Two.\n`);
  void C.submitCaptions();
  await settle();
  r.out[0].fail(new Error("Failed to fetch"));
  await settle();
  assert.equal(r.cap.busy, true, "the next dialog's press is still out");
  assert.equal(r.cap.error, "", "the cancelled press's refusal is not the next dialog's");
  r.out[1].fail(Object.assign(new Error("that doesn't look like a .vtt caption file"), { status: 400 }));
  await settle();
  assert.equal(r.cap.busy, false);
  assert.equal(r.cap.error, "that doesn't look like a .vtt caption file", "its own refusal is said in it");
  assert.deepEqual([r.added, r.landed, r.said], [0, [], []]);
});

test("the same captions captured again after the dialog was cancelled mid-save go under the first press's key", async () => {
  const r = room();
  const v = fresh();
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  r.cap = null;
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  assert.equal(r.out.length, 2);
  assert.ok(r.out[0].key);
  assert.equal(r.out[1].key, r.out[0].key, "the same bytes under a new key: the server adds the source twice");
  r.out[0].answer(transcript);
  await settle();
  r.out[1].answer(transcript);
  await settle();
  assert.equal(r.cap, null, "its own answer closes the second dialog");
  assert.deepEqual(r.landed, ["r1", "r1"], "each landing puts the board's snapshot in its slot");
  assert.deepEqual(r.said, ["A talk — 1 cues"], "one source, told once");
});

test("the cancelled dialog's late landing does not let the captions go while the next dialog's press of them is out", async () => {
  const r = room();
  const v = fresh();
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  r.cap = null;
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  r.out[0].answer(transcript);
  await settle();
  r.out[1].fail(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(r.cap.error, "Failed to fetch");
  pressIt(r);
  await settle();
  assert.equal(r.out.length, 3);
  assert.equal(r.out[2].key, r.out[0].key, "a new key for the same captions: the server makes a second source");
  r.out[2].answer(transcript);
  await settle();
  assert.equal(r.cap, null, "the replay closes the second dialog");
  assert.deepEqual(r.said, ["A talk — 1 cues"], "one source, told once");
});

test("the cancelled dialog's landing, come while the next dialog is filled in with the same captions, does not let them go", async () => {
  const r = room();
  const v = fresh();
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  r.cap = null;
  r.cap = captions("");
  type(r, v);
  r.out[0].answer(transcript);
  await settle();
  assert.ok(r.cap, "the landing leaves the next dialog up");
  pressIt(r);
  await settle();
  assert.equal(r.out.length, 2);
  assert.equal(r.out[1].key, r.out[0].key, "a new key for the same captions: the server makes the talk a second time");
  r.out[1].answer(transcript);
  await settle();
  assert.equal(r.cap, null, "the replay closes the next dialog");
  assert.deepEqual([r.landed, r.said], [["r1", "r1"], ["A talk — 1 cues"]], "one source, landed in both, told once");
});

test("the same captions captured again from a dialog whose title was read again go under the first key, with the first body", async () => {
  const r = room();
  const v = fresh();
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  r.cap = null;
  r.cap = { ...captions(""), title: TALK, author: "" };
  type(r, v);
  r.out[0].answer(transcript);
  await settle();
  pressIt(r);
  await settle();
  assert.equal(r.out.length, 2);
  assert.equal(r.out[1].key, r.out[0].key, "the same captions under a second key: the server makes the talk twice");
  assert.deepEqual(r.out[1].body, r.out[0].body, "one key with another body: the server refuses it (422)");
  r.out[1].answer(transcript);
  await settle();
  assert.equal(r.cap, null, "the replay closes the next dialog");
  assert.deepEqual([r.landed, r.said], [["r1", "r1"], ["A talk — 1 cues"]], "one source, under the title it was made with, told once");
});

test("the same captions cleared and pasted again after a failure go under the first key; other captions do not", async () => {
  const r = room();
  const v = fresh();
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  r.out[0].fail(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(r.cap.error, "Failed to fetch");
  type(r, "");
  type(r, v);
  pressIt(r);
  await settle();
  assert.equal(r.out[1].key, r.out[0].key, "the same bytes under a new key: a second source if the first was made");
  r.out[1].fail(new TypeError("Failed to fetch"));
  await settle();
  type(r, `${v}Two.\n`);
  pressIt(r);
  await settle();
  assert.notEqual(r.out[2].key, r.out[0].key, "other captions under the old key would be refused (422)");
});

test("the library's link form and the dialog's link step share the rule: one link, one key", async () => {
  const r = room();
  const url = `https://example.org/article-${++n}`;
  void C.saveLink("b1", url).catch(() => {});
  await settle();
  r.cap = linkStep("");
  type(r, url);
  pressIt(r);
  await settle();
  assert.equal(r.out.length, 2);
  assert.ok(r.out[0].key);
  assert.equal(r.out[1].key, r.out[0].key, "the same link from the form and the dialog is one capture");
});

test("the form's late answer for a YouTube link leaves a dialog opened meanwhile as it is, and keeps its link", async () => {
  const r = room();
  const saved = C.saveLink("b1", TALK).then((x: string) => x, (e: Error) => e);
  await settle();
  const open = captions(fresh());
  r.cap = open;
  r.out[0].answer({ kind: "youtube", url: TALK, title: "A talk", ytDlpCommand: "yt-dlp" });
  const said = await saved;
  assert.equal(r.cap, open, "the form's answer replaced the open dialog: its pasted captions are gone");
  assert.ok(said instanceof Error && /dialog is open/.test(said.message), `the form is told why, and keeps its link (said ${String(said)})`);
  r.cap = null;
  const again = C.saveLink("b1", TALK);
  await settle();
  r.out[1].answer({ kind: "youtube", url: TALK, title: "A talk", ytDlpCommand: "yt-dlp" });
  assert.equal(await again, "captions");
  assert.equal(r.cap.step, "captions");
  assert.equal(r.cap.url, TALK);
});

test("the dialog's replay of a link the form landed first still lands in the dialog: the board's snapshot, the receipt, the toast", async () => {
  const r = room();
  const url = `https://example.org/article-${++n}`;
  const saved = C.saveLink("b1", url);
  await settle();
  r.cap = linkStep("");
  type(r, url);
  pressIt(r);
  await settle();
  const article = { kind: "article", resourceId: "r1", title: "An article", state: { board: { id: "b1" } } };
  r.out[0].answer(article);
  assert.equal(await saved, "added");
  assert.deepEqual([r.added, r.landed, r.said], [1, [], []], "the form's row is its receipt: nothing is told");
  r.out[1].answer(article);
  await settle();
  assert.equal(r.cap, null);
  assert.deepEqual(r.landed, ["r1"], "the replay's snapshot goes to the open board");
  assert.deepEqual(r.said, ["An article — added"], "and the capture is told, once");
});

test("pressed again after its source was deleted, a capture is made anew: a replay of the deleted source never lands", async () => {
  const r = room();
  const v = fresh();
  r.cap = captions("");
  type(r, v);
  pressIt(r);
  await settle();
  r.out[0].fail(new TypeError("Failed to fetch"));
  await settle();
  pressIt(r);
  await settle();
  assert.equal(r.out[1].key, r.out[0].key, "the press again is the same capture");
  r.out[1].answer({ ...transcript, state: { board: { id: "b1" }, resources: [] } });
  await settle();
  assert.deepEqual(r.landed, [], "a replay of a deleted source landed: the dialog says added, the board has nothing");
  assert.equal(r.out.length, 3, "the bytes go again");
  assert.notEqual(r.out[2].key, r.out[0].key, "under a new key: the old one can only replay the deleted source");
  r.out[2].answer({ ...transcript, resourceId: "r2", state: { board: { id: "b1" }, resources: [{ id: "r2" }] } });
  await settle();
  assert.equal(r.cap, null);
  assert.deepEqual([r.landed, r.said], [["r2"], ["A talk — 1 cues"]], "the new source lands, and is told");
});
