import { createHash } from "node:crypto";
import type { GeminiFile } from "../../platform/llm/gemini.ts";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PER_MESSAGE, imageIds, replaceImages } from "../../../shared/images/ref.ts";
import { imagesRepo } from "./repo.ts";
import type { Sniffed } from "./sniff.ts";

// Far past any screenshot, short of a decompression bomb.
export const IMAGE_MAX_SIDE = 8000;

export const imageIdOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

export function refusal(bytes: Uint8Array, sniffed: Sniffed | null): string | null {
  if (!bytes.length) return "that image is empty";
  if (bytes.length > IMAGE_MAX_BYTES) return `that image is over ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB, even shrunk`;
  if (!sniffed) return "that isn't a PNG, JPEG, WebP or GIF image";
  if (!sniffed.w || !sniffed.h || sniffed.w > IMAGE_MAX_SIDE || sniffed.h > IMAGE_MAX_SIDE) return `that image is larger than ${IMAGE_MAX_SIDE} pixels on a side`;
  return null;
}

export const missingImages = (ids: string[]): string[] => ids.filter((id) => !imagesRepo.imageMeta.get(id));

// A thread's images ride every turn, so their base64 is kept rather than re-read from disk each turn.
const KEEP_CHARS = 24 * 1024 * 1024;
const kept = new Map<string, GeminiFile>();
let keptChars = 0;

function fileOf(id: string): GeminiFile | null {
  const hit = kept.get(id);
  if (hit) { kept.delete(id); kept.set(id, hit); return hit; }
  const row = imagesRepo.imageBytes.get(id);
  if (!row) return null;
  const file = { mimeType: row.mime, data: Buffer.from(row.bytes).toString("base64") };
  kept.set(id, file); keptChars += file.data.length;
  for (const [k, f] of kept) { if (keptChars <= KEEP_CHARS || kept.size <= 1) break; kept.delete(k); keptChars -= f.data.length; }
  return file;
}

// An image the room no longer has is named as missing rather than silently dropped.
export function forModel(text: string, numberedFrom = 0): { text: string; files?: GeminiFile[] } {
  if (!imageIds(text).length) return { text };
  const files: GeminiFile[] = [];
  const at = new Map<string, number>();
  const words = replaceImages(text, (id) => {
    if (!at.has(id)) {
      const f = fileOf(id);
      if (!f) return "[an image that is no longer stored]";
      files.push(f); at.set(id, files.length);
    }
    return `[image ${numberedFrom + at.get(id)!}]`;
  });
  return files.length ? { text: words, files } : { text: words };
}

export function turnImagesRefusal(text: string): string | null {
  const ids = imageIds(text);
  if (ids.length > IMAGE_MAX_PER_MESSAGE) return `a message can carry ${IMAGE_MAX_PER_MESSAGE} images at most`;
  if (missingImages(ids).length) return "an image in that message was never uploaded — paste it again";
  return null;
}
