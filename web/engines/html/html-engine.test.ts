import { test } from "node:test";
import assert from "node:assert/strict";
import { STRATA, type ToPage } from "./protocol.ts";

// The engine needs only a window to listen on and iframes to post to; both are stubbed here.
type Heard = (e: { source: unknown; data: unknown }) => void;
let hear: Heard = () => {};
class Frame {
  posted: ToPage[] = [];
  contentWindow = { postMessage: (m: Record<string, ToPage>) => { this.posted.push(m[STRATA]); } };
  isConnected = true;
  parentElement: unknown = null;
  src = "";
  className = "";
  setAttribute(): void {}
  remove(): void { this.isConnected = false; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}
const frames: Frame[] = [];
Object.assign(globalThis, {
  addEventListener: (_: string, fn: Heard) => { hear = fn; },
  removeEventListener: () => {},
  document: { createElement: () => { const f = new Frame(); frames.push(f); return f; } },
});
const { HtmlEngine } = await import("./HtmlEngine.ts");
const host = { appendChild(f: Frame) { f.parentElement = host; } } as unknown as HTMLElement;
const ready = (f: Frame) => hear({ source: f.contentWindow, data: { [STRATA]: { t: "ready" } } });
const marks = (f: Frame) => f.posted.filter((m) => m.t === "marks").map((m) => (m as { marks: { id: string }[] }).marks.map((x) => x.id));
const hooks = { onSelect() {}, onMark() {}, onPress() {}, onLoad: async () => null, onSave: async () => {} };

test("a paint sent while the last page's frame is still up reaches the page that replaces it", () => {
  const engine = new HtmlEngine(hooks as never);
  engine.open(host, "/live/one");
  ready(frames[0]);
  engine.paint([{ id: "mk-one", start: 0, end: 3, quote: "one", note: true, box: null }], null);
  // the reader paints the next page's marks before the frame changes, as a layout effect runs before an effect
  engine.paint([{ id: "mk-two", start: 0, end: 3, quote: "two", note: true, box: null }], null);
  engine.open(host, "/live/two");
  assert.deepEqual(marks(frames[1]), [], "nothing is sent before the new page is ready");
  ready(frames[1]);
  assert.deepEqual(marks(frames[1]), [["mk-two"]], "the new page gets its marks once, when it is ready");
});

test("a paint asked before any frame existed is sent once, not twice", () => {
  const engine = new HtmlEngine(hooks as never);
  engine.paint([{ id: "mk-early", start: 0, end: 5, quote: "early", note: false, box: null }], null);
  engine.open(host, "/live/three");
  const f = frames[frames.length - 1];
  ready(f);
  assert.deepEqual(marks(f), [["mk-early"]]);
});

test("the page's height reaches the host only from the frame that is open", () => {
  const heights: number[] = [];
  const engine = new HtmlEngine({ ...hooks, onHeight: (h: number) => heights.push(h) } as never);
  engine.open(host, "/live/four");
  const old = frames[frames.length - 1];
  engine.open(host, "/live/five");
  const f = frames[frames.length - 1];
  hear({ source: old.contentWindow, data: { [STRATA]: { t: "height", h: 900 } } });
  hear({ source: f.contentWindow, data: { [STRATA]: { t: "height", h: 512 } } });
  assert.deepEqual(heights, [512]);
});
