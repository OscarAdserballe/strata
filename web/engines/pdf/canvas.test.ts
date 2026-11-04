import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfCanvasScale, PDF_CANVAS_MAX_PIXELS, PDF_CANVAS_MAX_SIDE } from "./canvas.ts";

test("ordinary pages retain their requested resolution", () => {
  assert.equal(pdfCanvasScale(595, 842, 1.5), 1.5);
});

test("large, zoomed and unusually narrow pages stay within both bitmap limits", () => {
  for (const [width, height] of [[595, 842], [14400, 14400], [100, 14400], [14400, 100]]) {
    for (const requested of [1, 1.5, 3, 6]) {
      const scale = pdfCanvasScale(width, height, requested);
      const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
      assert.ok(w * h <= PDF_CANVAS_MAX_PIXELS);
      assert.ok(w <= PDF_CANVAS_MAX_SIDE && h <= PDF_CANVAS_MAX_SIDE);
      assert.ok(scale <= requested);
      assert.ok(Math.abs((width * scale) / (height * scale) - width / height) < 1e-8);
    }
  }
});
