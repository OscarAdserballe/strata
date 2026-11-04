export const plainQuote = (s: string | null | undefined): string => String(s || "")
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1")
  .replace(/\*(.+?)\*/g, "$1").replace(/_(.+?)_/g, "$1").replace(/`(.+?)`/g, "$1");

/* safe to interpolate into HTML: only [a-z0-9-] survives */
export const slugOf = (s: string): string => plainQuote(s).toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-");

/* At most three digits, so a heading that opens with a year stays prose. */
export const headingNum = (body: string): [string, string, string] | null => {
  const m = String(body || "").match(/^(\d{1,3}(?:\.\d+)*)(\s+)(.*)$/);
  return m ? [m[1], m[2], m[3]] : null;
};
