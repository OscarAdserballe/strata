// Never the client's word: stored bytes are served from this origin with the type sniffed here.

export interface Sniffed { mime: string; w: number; h: number }

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function png(b: Uint8Array): Sniffed | null {
  if (b.length < 24 || ascii(b, 1, 3) !== "PNG" || b[0] !== 0x89 || ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", w: u32be(b, 16), h: u32be(b, 20) };
}

function gif(b: Uint8Array): Sniffed | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return null;
  return { mime: "image/gif", w: u16le(b, 6), h: u16le(b, 8) };
}

/* a JPEG's size is in its first start-of-frame segment, after however many others */
function jpeg(b: Uint8Array): Sniffed | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = u16be(b, i + 2);
    // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { mime: "image/jpeg", w: u16be(b, i + 7), h: u16be(b, i + 5) };
    i += 2 + len;
  }
  return null;
}

/* RIFF....WEBP, then one of three chunk kinds, each with its own way of writing the size */
function webp(b: Uint8Array): Sniffed | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const kind = ascii(b, 12, 4);
  if (kind === "VP8X") return { mime: "image/webp", w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
  if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
    return { mime: "image/webp", w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  if (kind === "VP8L" && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { mime: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export function sniffImage(bytes: Uint8Array): Sniffed | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
}
