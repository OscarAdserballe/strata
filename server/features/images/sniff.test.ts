import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImage } from "./sniff.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("the four formats are read from their own headers, with their size", () => {
  assert.deepEqual(sniffImage(PNG), { mime: "image/png", w: 1, h: 1 });
  // GIF89a, 3×2
  assert.deepEqual(sniffImage(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0, 0, 0])), { mime: "image/gif", w: 3, h: 2 });
  // JPEG: SOI, an APP0 segment, then SOF0 with height 480 and width 640
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffImage(jpeg), { mime: "image/jpeg", w: 640, h: 480 });
  // WebP, extended (VP8X): canvas 1600×900 stored as size-1 in 24 bits
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0); webp.write("WEBP", 8); webp.write("VP8X", 12);
  webp.writeUIntLE(1599, 24, 3); webp.writeUIntLE(899, 27, 3);
  assert.deepEqual(sniffImage(webp), { mime: "image/webp", w: 1600, h: 900 });
});

test("anything else is not an image here: SVG, HTML, a PDF, nothing", () => {
  for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"/>', "<html><script>alert(1)</script>", "%PDF-1.7", ""])
    assert.equal(sniffImage(Buffer.from(s)), null, s);
});
