import { imagesInMarkdown, imageSrc } from "../../engines/prose/image-src.ts";

/** Stored notes name images `img:<id>`; the editor draws them from their URL. */
export const toEditor = (md: string): string => imagesInMarkdown(softBreaks(md));

export function fromEditor(md: string): string {
  const at = imageSrc("");
  let fenced = false;
  // a line break inside a paragraph comes back as two trailing spaces; store it as the newline that was typed
  const out = md.split("\n").map((line) => { if (/^\s*(```|~~~)/.test(line)) fenced = !fenced; return fenced ? line : line.replace(/ {2}$/, ""); }).join("\n").replace(/\n+$/, "");
  return out.includes(at) ? out.split(`](${at}`).join("](img:") : out;
}

// a lone newline in plain notes is a line you meant; Markdown would fold it into the one before
export function softBreaks(md: string): string {
  const lines = md.split("\n");
  let fenced = false;
  return lines.map((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const next = lines[i + 1];
    if (fenced || next === undefined || !line.trim() || !next.trim()) return line;
    if (BLOCK.test(next) || BLOCK.test(line)) return line;
    return line.endsWith("\\") || / {2}$/.test(line) ? line : line + "\\";
  }).join("\n");
}
const BLOCK = /^\s*([-*+] |\d+[.)] |#{1,6} |> |```|~~~|\|)/;
