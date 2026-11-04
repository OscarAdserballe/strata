import { cardFaces, checkedTidy, type CardFaces } from "../../../shared/cards/card-tidy.ts";
import { imageParts, withoutImages } from "../../../shared/images/ref.ts";

type Tidy = (body: { type?: string; faces: Record<string, unknown> }) => Promise<{ faces: Record<string, unknown> }>;

// a model call that never settles must not hold the draft: past the deadline the editor re-arms
export function withDeadline<T>(p: Promise<T>, ms: number, what: string, said?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(said ?? `${what} didn't come back after ${Math.round(ms / 1000)}s — the wire may be down; your words are still here, try again`));
    }, ms);
    p.then((v) => { if (done) return; done = true; clearTimeout(t); resolve(v); },
           (e) => { if (done) return; done = true; clearTimeout(t); reject(e); });
  });
}

// image tokens sit out the tidy: a model may reword, move or drop a string it does not understand
export function shieldImages(faces: CardFaces): { bare: CardFaces; restore(tidied: CardFaces): CardFaces; empty: boolean } {
  const held = new Map<string, { refs: string; lead: boolean }>();
  const bare: CardFaces = {};
  for (const [k, v] of Object.entries(faces)) {
    if (typeof v !== "string" || !v.includes("](img:")) { bare[k] = v; continue; }
    const parts = imageParts(v);
    const refs = v.match(/!\[[^\]\n]{0,200}\]\(img:[0-9a-f]{16}\)/g) ?? [];
    held.set(k, { refs: refs.join("\n"), lead: "id" in parts[0] || (parts.length > 1 && "text" in parts[0] && !parts[0].text.trim()) });
    bare[k] = withoutImages(v).text;
  }
  const empty = !Object.values(bare).some((v) => (Array.isArray(v) ? v.some((x) => x.trim()) : v.trim()));
  return {
    bare, empty,
    restore(tidied) {
      const out: CardFaces = { ...tidied };
      for (const [k, h] of held) {
        const words = String(out[k] ?? "");
        out[k] = !words.trim() ? h.refs : h.lead ? `${h.refs}\n${words}` : `${words}\n${h.refs}`;
      }
      return out;
    },
  };
}

export function createCardTidier(tidy: Tidy, deadlineMs = 50_000) {
  let key = "";
  let formattedKey = "";
  let result: CardFaces | undefined;
  return async (type: string | undefined, draft: Record<string, unknown>): Promise<CardFaces> => {
    const faces = cardFaces(type, draft);
    const nextKey = JSON.stringify([type, faces]);
    if ((nextKey === key || nextKey === formattedKey) && result) return structuredClone(result);
    const shield = shieldImages(faces);
    const checked = shield.empty ? faces : shield.restore(checkedTidy(shield.bare,
      (await withDeadline(Promise.resolve().then(() => tidy({ type, faces: shield.bare })), deadlineMs, "Tidying")).faces));
    key = nextKey; formattedKey = JSON.stringify([type, checked]); result = checked;
    return structuredClone(checked);
  };
}
