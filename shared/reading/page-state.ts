/** The most state a live page may keep: its JSON text, in UTF-8 bytes. */
export const PAGE_STATE_MAX = 64 * 1024;

export function pageStateProblem(value: unknown): string | null {
  if (typeof value !== "string") return "send the page's state as { value: \"<JSON>\" }";
  if (new TextEncoder().encode(value).length > PAGE_STATE_MAX) return `a page keeps at most ${PAGE_STATE_MAX / 1024} KB of state`;
  try { JSON.parse(value); } catch { return "the page's state isn't JSON"; }
  return null;
}
