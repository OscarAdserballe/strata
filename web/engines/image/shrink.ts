// Shrunk on the device: every kept copy lives in the database, and every backup is the whole database.
export const LONG_SIDE = 1600;
// a small PNG diagram is kept as it came, sharp edges and all
const KEEP_PNG_BYTES = 300 * 1024;
const QUALITY = 0.82;
const MAX_BYTES = 3 * 1024 * 1024;

export interface Shrunk { blob: Blob; mime: string; w: number; h: number }

export function fitWithin(w: number, h: number, side = LONG_SIDE): { w: number; h: number } {
  const k = Math.min(1, side / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export async function shrinkImage(file: Blob): Promise<Shrunk> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    const small = Math.max(width, height) <= LONG_SIDE;
    if (small && ((file.type === "image/png" && file.size <= KEEP_PNG_BYTES) || (file.type === "image/gif" && file.size <= MAX_BYTES)))
      return { blob: file, mime: file.type, w: width, h: height };
    const size = fitWithin(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = size.w; canvas.height = size.h;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("this browser could not draw the image to shrink it");
    // a transparent screenshot drawn onto JPEG would go black behind its text
    g.fillStyle = "#fff"; g.fillRect(0, 0, size.w, size.h);
    g.drawImage(bitmap, 0, 0, size.w, size.h);
    let blob = await encode(canvas, "image/webp", QUALITY);
    // a browser that cannot write WebP hands back a PNG instead: say JPEG, then
    if (!blob || blob.type !== "image/webp") blob = await encode(canvas, "image/jpeg", 0.85);
    if (!blob) throw new Error("this browser could not shrink the image");
    if (blob.size > MAX_BYTES) throw new Error("that image is still over 3 MB after shrinking");
    return { blob, mime: blob.type, w: size.w, h: size.h };
  } finally { bitmap.close(); }
}

export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
