import { facesOf } from "./faces.ts";

export type CardFaces = Record<string, string | string[]>;
export const CARD_FACE_MAX = 4000;

export function cardFaces(type: unknown, draft: Record<string, unknown>): CardFaces {
  const faces: CardFaces = {};
  for (const { key } of facesOf(type)) {
    const value = draft[key];
    if (value === undefined) continue;
    if (key === "options" && !Array.isArray(value)) throw new Error("Card options must be a list of text.");
    if (key !== "options" && typeof value !== "string") throw new Error("Each card face must be text.");
    const strings = key === "options" && Array.isArray(value) ? value : [value];
    if (strings.some(s => typeof s !== "string" || s.length > CARD_FACE_MAX)) {
      throw new Error(`Each card face must be text of at most ${CARD_FACE_MAX} characters.`);
    }
    faces[key] = value as string | string[];
  }
  if (!Object.values(faces).some(v => Array.isArray(v) ? v.some(s => s.trim()) : v.trim())) {
    throw new Error("Nothing to tidy.");
  }
  return faces;
}

// Reject incomplete or oversized responses as a whole. Never silently truncate a face.
export function checkedTidy(original: CardFaces, response: unknown): CardFaces {
  const fail = () => { throw new Error("Couldn't safely tidy this card. Your words are still here; try formatting again."); };
  if (!response || typeof response !== "object" || Array.isArray(response)) return fail();
  const result: CardFaces = {};
  const valid = (before: string, after: unknown): after is string =>
    typeof after === "string" && after.length <= CARD_FACE_MAX && (before.trim() ? !!after.trim() : after === before);
  for (const [key, value] of Object.entries(original)) {
    const next = (response as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      if (!Array.isArray(next) || next.length !== value.length || !value.every((v, i) => valid(v, next[i]))) return fail();
      result[key] = next;
    } else {
      if (!valid(value, next)) return fail();
      result[key] = next;
    }
  }
  return result;
}
