export interface DeleteTarget { del?: { res?: string; pair?: string }; marksN?: number; kp?: { kept: number } | null }

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** The second press says what goes with a source that holds the reader's own work, so nothing is lost by surprise. */
export function deleteAsk(t: DeleteTarget): string {
  if (!t.del?.res) return "Delete the pair and its cards?";
  const mine = [t.marksN ? count(t.marksN, "note") : "", t.kp?.kept ? count(t.kp.kept, "kept card") : ""].filter(Boolean);
  return mine.length ? `Delete it, with your ${mine.join(" and ")}?` : "Delete it?";
}
