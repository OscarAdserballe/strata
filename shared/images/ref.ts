// An image is a token inside text, so every path that saves, retries or merges that text carries it.
export const IMAGE_ID = /^[0-9a-f]{16}$/;
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_MAX_PER_MESSAGE = 6;
// Anything else is refused: SVG above all, which can carry script.
export const IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// HEIC and the like are drawn, then re-encoded to one of IMAGE_MIMES.
export const isImageFile = (f: { type: string }): boolean => /^image\/(png|jpe?g|webp|gif|heic|heif|avif|bmp)$/i.test(f.type);

const REF = /!\[([^\]\n]{0,200})\]\(img:([0-9a-f]{16})\)/g;

export const imageRef = (id: string, alt = ""): string => `![${alt.replace(/[\]\n]/g, " ").slice(0, 200)}](img:${id})`;

export type ImagePart = { text: string } | { id: string; alt: string };

export function imageParts(text: string): ImagePart[] {
  const out: ImagePart[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ id: m[2], alt: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export const imageIds = (text: string): string[] => [...new Set(Array.from(text.matchAll(REF), (m) => m[2]))];

export const hasImages = (text: string): boolean => text.includes("](img:") && imageIds(text).length > 0;

export function withoutImages(text: string): { text: string; ids: string[] } {
  return { text: text.replace(REF, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), ids: imageIds(text) };
}

export const replaceImages = (text: string, stand: (id: string, n: number) => string): string => {
  let n = 0;
  return text.replace(REF, (_all, _alt, id: string) => stand(id, ++n));
};

export function removeImage(text: string, id: string): string {
  const one = new RegExp(`!\\[[^\\]\\n]{0,200}\\]\\(img:${id}\\)`, "g");
  return text.replace(new RegExp(`\\n${one.source}(?=\\n|$)`, "g"), "").replace(one, "").replace(/^\n+/, "");
}
