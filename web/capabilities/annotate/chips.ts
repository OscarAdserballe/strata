// The keys of the menu over picked words and of the chips under a mark: N, A or C picks a chip, any other letter starts the note.

export type ChipAct = "note" | "ask" | "card" | "remove";
/** what the chips under a mark offer; a note always */
export interface ChipOffer { note: true; ask: boolean; card: boolean; remove: boolean }

export const CHIP_LABELS: Record<Exclude<ChipAct, "remove">, string> = { note: "Note", ask: "Ask", card: "Card" };

interface Key { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }
const bare = (e: Key) => !e.metaKey && !e.ctrlKey && !e.altKey;
const MODIFIERS = new Set(["Shift", "CapsLock", "Control", "Alt", "Meta", "AltGraph", "Fn", "Dead", "Process", "Unidentified"]);

/** M on picked words marks them. */
export const isMarkKey = (e: Key): boolean => bare(e) && e.key.toLowerCase() === "m";

// a bare modifier does nothing, so a capital letter still reaches the note; Esc alone stops at the chips
export function chipKey(e: Key, offer: ChipOffer): { act: ChipAct; prefill: string } | { drop: true; pass: boolean } | null {
  if (MODIFIERS.has(e.key)) return null;
  if (e.key === "Escape") return { drop: true, pass: false };
  if (!bare(e) || e.key.length !== 1 || !/\p{L}/u.test(e.key)) return { drop: true, pass: true };
  const k = e.key.toLowerCase();
  if (k === "n") return { act: "note", prefill: "" };
  if (k === "a" && offer.ask) return { act: "ask", prefill: "" };
  if (k === "c" && offer.card) return { act: "card", prefill: "" };
  return { act: "note", prefill: e.key };
}
