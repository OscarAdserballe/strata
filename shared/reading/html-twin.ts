// The text a live HTML source is distilled, searched and asked from: its readable words, as Markdown.

const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg", "canvas", "button", "select", "textarea"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "li", "ul", "ol",
  "table", "tr", "blockquote", "pre", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "br", "hr", "form", "label"]);
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×", minus: "−", middot: "·", deg: "°", le: "≤", ge: "≥", ne: "≠", approx: "≈" };

const decode = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITY[e.toLowerCase()] ?? m;
});

export function htmlTwin(html: string): string {
  const out: string[] = [];
  let line = "", skip = 0, skipping = "";
  const flush = () => { const t = line.replace(/\s+/g, " ").trim(); if (t) out.push(t); line = ""; };
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const body = html.replace(/<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>/g, "");
  const tags = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tags.exec(body))) {
    const [, close, rawName, selfClose, text] = m;
    if (text !== undefined) { if (!skip) line += decode(text); continue; }
    const name = rawName.toLowerCase();
    if (skip) {
      if (name === skipping) skip += close ? -1 : selfClose ? 0 : 1;
      continue;
    }
    if (SKIP.has(name) && !close && !selfClose) { skip = 1; skipping = name; continue; }
    const h = name.match(/^h([1-6])$/);
    if (h) { flush(); if (!close) line = "#".repeat(+h[1]) + " "; continue; }
    if (BLOCK.has(name) || name === "td" || name === "th") { if (name === "td" || name === "th") line += " "; else flush(); }
  }
  flush();
  const lines = out.filter((l) => !/^#+$/.test(l));
  if (title && !lines.some((l) => l.startsWith("# "))) lines.unshift("# " + decode(title[1]).replace(/\s+/g, " ").trim());
  return lines.join("\n\n");
}

/** A page with its own design (code, drawing or styles) shows as itself; bare markup reads better as an article. */
export const rendersAsPage = (html: string): boolean =>
  /<(script|canvas|svg|input|style)\b|<link\b[^>]*\brel=["']?stylesheet\b/i.test(html);
