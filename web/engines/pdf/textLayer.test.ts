import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLayer } from "./textLayer.ts";

function slide(canvas: { offsetLeft: number; offsetTop: number; clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number } | null, pw: string | undefined, hasLayer = true) {
  const props = new Map<string, string>();
  const style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = {};
  style.setProperty = (k, v) => { props.set(k, v); };
  const layer = hasLayer ? { dataset: pw == null ? {} : { pw }, style } : null;
  const el = { querySelector: (sel: string) => (sel === ".tlayer" ? layer : sel === "canvas" ? canvas : null) } as unknown as ParentNode;
  return { el, style, props };
}

test("a text layer sits on the canvas's content box, a border's pixel in, scaled CSS px per PDF point", () => {
  const s = slide({ offsetLeft: 12, offsetTop: 30, clientLeft: 1, clientTop: 1, clientWidth: 600, clientHeight: 800 }, "612");
  assert.equal(fitLayer(s.el), true);
  assert.deepEqual([s.style.left, s.style.top, s.style.width, s.style.height], ["13px", "31px", "600px", "800px"]);
  assert.equal(s.props.get("--scale-factor"), String(600 / 612));
});

test("a canvas with no size yet is not fitted (false, to be tried again); no layer, no canvas or no page width is nothing to fit", () => {
  const sized = { offsetLeft: 0, offsetTop: 0, clientLeft: 0, clientTop: 0, clientWidth: 600, clientHeight: 800 };
  const unsized = slide({ ...sized, clientLeft: 1, clientTop: 1, clientWidth: 0, clientHeight: 0 }, "612");
  assert.equal(fitLayer(unsized.el), false);
  assert.equal(unsized.style.left, undefined);
  const noLayer = slide(sized, "612", false);
  assert.equal(fitLayer(noLayer.el), true);
  assert.equal(noLayer.style.left, undefined);
  assert.equal(fitLayer(slide(null, "612").el), true);
  const noWidth = slide(sized, undefined);
  assert.equal(fitLayer(noWidth.el), true);
  assert.equal(noWidth.style.left, undefined);
});
