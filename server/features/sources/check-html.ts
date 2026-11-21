// Refuses an agent's HTML page that would open blank: nothing to show, cut off mid-file, or a script that can't even parse.
import { Script } from "node:vm";
import { htmlTwin } from "../../../shared/reading/html-twin.ts";

const CLASSIC = /^(|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|module)$/;
const NEEDS_BUILD = /babel|jsx|tsx|typescript/;
const DRAWN = /<(script|canvas|svg|img|video|iframe|object|embed|picture)\b/i;
const STUB = /^[\s\p{P}]*(placeholder|todo|tbd|tk|lorem ipsum.*|coming soon|page|content|draft|wip|\.\.\.|…)?[\s\p{P}]*$/iu;

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const lineOf = (e: unknown): string => {
  const m = /:(\d+)\s*$/m.exec(String((e as { stack?: string }).stack ?? "").split("\n")[0] ?? "");
  return m ? `, line ${m[1]}` : "";
};

/** What is wrong with a page, each a sentence an agent can act on; empty when it would open. `remoteOnly` asks scripts to load from https; `document` asks for a whole HTML page with real words or a drawing. */
export function htmlProblems(html: string, opts: { remoteOnly?: boolean; document?: boolean } = {}): string[] {
  const problems: string[] = [];
  const bare = html.replace(/<!--[\s\S]*?-->/g, "");
  const text = htmlTwin(bare.replace(/<title\b[\s\S]*?<\/title\s*>/gi, "")).trim();
  if (opts.document && !/<(html|body)\b/i.test(bare)) problems.push("the page isn't an HTML document: send the whole page, with <html> and <body>");
  if (!text && !DRAWN.test(bare)) problems.push("the page shows nothing: no text, and no script or drawing");
  else if (opts.document && STUB.test(text) && !DRAWN.test(bare)) problems.push(`the page is only "${text.slice(0, 40)}", a placeholder: post the finished page`);
  const opened = (bare.match(/<script\b/gi) ?? []).length, closed = (bare.match(/<\/script\s*>/gi) ?? []).length;
  if (opened > closed) problems.push("a <script> is never closed, so the page looks cut off");
  if ((bare.match(/<style\b/gi) ?? []).length > (bare.match(/<\/style\s*>/gi) ?? []).length) problems.push("a <style> is never closed, so the page looks cut off");
  if (/<body\b/i.test(bare) && !/<\/body\s*>/i.test(bare)) problems.push("the page has no </body>, so it looks cut off");
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null, i = 0;
  while ((m = scripts.exec(bare))) {
    i++;
    const [, attrs, body] = m;
    const type = (attr(attrs, "type") ?? "").trim().toLowerCase();
    const src = attr(attrs, "src");
    if (NEEDS_BUILD.test(type)) { problems.push(`script ${i} is type="${type}", which the frame can't run; compile it and ship plain JavaScript`); continue; }
    if (!CLASSIC.test(type)) continue;   // JSON, templates and other data blocks aren't run
    if (src !== null) {
      if (opts.remoteOnly && !/^https:\/\//i.test(src.trim())) problems.push(`script ${i} loads "${src}"; scripts load from an https CDN or sit inline`);
      continue;
    }
    if (type === "module" || !body.trim()) continue;   // Node parses modules only behind a flag
    try { new Script(body, { filename: `script ${i}` }); }
    catch (e) { problems.push(`script ${i}${lineOf(e)}: ${(e as Error).message}`); }
  }
  return problems;
}
