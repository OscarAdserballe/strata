/** What a key does while a mark's chips are up: a chip, a letter that starts the note, Esc, or nothing. */
export type ChipKey = { act: "note"; typed: string } | { act: "ask" } | { act: "card" } | { act: "drop" } | null;

type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">;

export function chipKey(e: Key): ChipKey {
  if (e.key === "Escape") return { act: "drop" };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  // shifted letters are typed, not chips: a note may open with a capital
  if (e.key === "n") return { act: "note", typed: "" };
  if (e.key === "a") return { act: "ask" };
  if (e.key === "c") return { act: "card" };
  return /^\p{L}$/u.test(e.key) ? { act: "note", typed: e.key } : null;
}
