const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A source's delete confirm: it names the notes that go with it, and the kept cards that stay. */
export function deleteAsk(del: { notes?: number; kept?: number }): string {
  const notes = del.notes || 0, kept = del.kept || 0;
  const ask = notes ? `delete it and its ${count(notes, "note")}?` : "delete this source?";
  return kept ? `${ask} (${count(kept, "kept card")} stay${kept === 1 ? "s" : ""} in Review)` : ask;
}
