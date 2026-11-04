import { readFileSync } from "node:fs";

/* KEY wins over KEY_FILE so a native process can still use plain environment variables. */
export function envGet(key: string): string | undefined {
  if (process.env[key] !== undefined) return process.env[key];
  const path = process.env[`${key}_FILE`];
  if (!path) return undefined;
  try { return readFileSync(path, "utf-8").trim(); } catch { return undefined; }
}

export async function fetchWithTimeout(url: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = 30_000, ...rest } = init;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try { return await fetch(url, { ...rest, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

/* Models emit raw LaTeX backslashes, which are illegal or silently wrong JSON escapes: escape them first. */
export function repairJsonBackslashes(s: string): string {
  return s.replace(/\\u[0-9a-fA-F]{4}|\\\\|\\(["/])|\\/g, (m) => {
    if (m.startsWith("\\u") || m === "\\\\" || m === '\\"' || m === "\\/") return m;
    return "\\\\";
  });
}

/* JSON.parse rejects raw control chars inside strings; string-aware, so structural whitespace is untouched. */
export function escapeRawControlsInStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    const code = s.charCodeAt(i);
    if (inStr && code < 0x20) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
    out += ch;
  }
  return out;
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const repaired = repairJsonBackslashes(t);
  try {
    return JSON.parse(repaired);
  } catch {
    return JSON.parse(escapeRawControlsInStrings(repaired));
  }
}
