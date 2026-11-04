import { headingNum, slugOf } from "../../../shared/reading/prose-slugs.ts";

export interface Rendered { html: string; maps: number[][] }

export function mdRender(text: string | null | undefined, breaks: boolean): Rendered {
  const src = String(text || "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const lineAt: number[] = []; { let o = 0; for (const ln of lines) { lineAt.push(o); o += ln.length + 1; } }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const maps: number[][] = [], out: string[] = [];
  let map: number[] = [];                        // the block being built: rendered char → source offset
  const nextB = () => maps.length;               // the data-b the next emitted block will get
  const emit = (html: string, end: number) => { map.push(end); maps.push(map); map = []; out.push(html); };

  // `fresh` means this starts a rendered line, so a leading space is intentional.
  function inline(s: string, base: number, fresh: boolean): string {
    let html = "", sp = !!fresh;
    const put = (ch: string, o: number) => { html += ch === " " && sp ? "&nbsp;" : esc(ch); sp = ch === " "; map.push(base + o); };
    const run = (a: number, b: number) => { for (let k = a; k < b; k++) put(s[k], k); };
    // Characters the renderer invents still need a map entry each, or later carets land off by one.
    const synth = (word: string, o: number) => { html += esc(word); sp = false; for (const _ of word) map.push(base + o); };
    const escUrl = (u: string) => esc(u).replace(/"/g, "%22");
    const escAttr = (u: string) => esc(u).replace(/"/g, "&quot;");
    const safeUrl = (u: string): string | null => (/^https?:\/\//i.test(u.trim()) ? u.trim() : null);
    const mediaKind = (u: string): "image" | "video" | "audio" | null => {
      let path: string;
      try { path = new URL(u).pathname.toLowerCase(); } catch { return null; }
      if (/\.(?:mp4|m4v|mov|webm|ogv)$/.test(path)) return "video";
      if (/\.(?:mp3|m4a|aac|wav|flac|oga|ogg|opus)$/.test(path)) return "audio";
      if (/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/.test(path)) return "image";
      return null;
    };

    // Brackets and the URL's parens are balanced, so "[a [b] c](u)" and ".../Foo_(bar)" survive.
    const linkAt = (i: number): { ts: number; te: number; url: string; end: number } | null => {
      if (s[i] !== "[") return null;
      let d = 1, j = i + 1;
      while (j < s.length && d) { if (s[j] === "[") d++; else if (s[j] === "]") d--; j++; }
      if (d || s[j] !== "(") return null;
      let p = 1, k = j + 1;
      while (k < s.length && p) { if (s[k] === "(") p++; else if (s[k] === ")") p--; k++; }
      if (p) return null;
      return { ts: i + 1, te: j - 1, url: s.slice(j + 1, k - 1), end: k };
    };

    // Media loads lazily with no referrer; unsafe URLs stay inert like bad links.
    const media = (source: string, href: string, at: number, a: number, b: number, hint?: "image" | "video" | "audio") => {
      const src = safeUrl(source), url = safeUrl(href), kind = hint ?? mediaKind(source) ?? "image";
      if (!src) {
        html += url ? `<a class="fig-missing" href="${escUrl(url)}" target="_blank" rel="noopener">` : `<span class="fig-missing">`;
        if (a < b) span(a, b); else synth("figure", at);
        html += url ? "</a>" : "</span>";
        return;
      }
      if (kind === "image") {
        html += url ? `<a class="media" href="${escUrl(url)}" target="_blank" rel="noopener">` : `<span class="media">`;
        html += `<img class="media-img" src="${escUrl(src)}" alt="${escAttr(s.slice(a, b))}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
        if (a < b) { html += `<span class="media-cap">`; span(a, b); html += "</span>"; }
        html += url ? "</a>" : "</span>";
        return;
      }
      html += `<span class="media">`;
      if (kind === "video") html += `<video class="media-video" src="${escUrl(src)}" controls preload="metadata" playsinline referrerpolicy="no-referrer"></video>`;
      else html += `<audio class="media-audio" src="${escUrl(src)}" controls preload="metadata" referrerpolicy="no-referrer"></audio>`;
      if (a < b) {
        html += url ? `<a class="media-cap" href="${escUrl(url)}" target="_blank" rel="noopener">` : `<span class="media-cap">`;
        span(a, b);
        html += url ? "</a>" : "</span>";
      }
      html += "</span>";
    };

    function span(a: number, b: number): void {
      let i = a;
      while (i < b) {
        const c = s[i];
        if (c === "!" && s[i + 1] === "[") {
          const l = linkAt(i + 1);
          if (l && l.end <= b) { media(l.url, l.url, i, l.ts, l.te); i = l.end; continue; }
        }
        if (c === "[") {
          const l = linkAt(i);
          if (l && l.end <= b) {
            // A link wrapping an image keeps both without nesting one anchor in another.
            const im = s[l.ts] === "!" ? linkAt(l.ts + 1) : null;
            if (im && im.end === l.te) { media(im.url, l.url, i, im.ts, im.te); i = l.end; continue; }
            const url = safeUrl(l.url);
            const kind = url && mediaKind(url);
            if (url && kind) { media(url, url, i, l.ts, l.te, kind); i = l.end; continue; }
            if (url) { html += `<a href="${escUrl(url)}" target="_blank" rel="noopener">`; span(l.ts, l.te); html += "</a>"; }
            else span(l.ts, l.te);                       // no usable href → just the text
            i = l.end; continue;
          }
        }
        if (c === "*" && s[i + 1] === "*") {
          const e = s.indexOf("**", i + 2);
          if (e > i + 2 && e + 2 <= b) { html += "<strong>"; span(i + 2, e); html += "</strong>"; i = e + 2; continue; }
        }
        if (c === "_" && s[i + 1] === "_") {
          const e = s.indexOf("__", i + 2);
          if (e > i + 2 && e + 2 <= b) { html += "<strong>"; span(i + 2, e); html += "</strong>"; i = e + 2; continue; }
        }
        // emphasis opens only at a word boundary, so snake_case and 3*4 stay literal
        if ((c === "*" || c === "_") && (i === 0 || /[\s(]/.test(s[i - 1])) && !/\s/.test(s[i + 1] || " ")) {
          const e = s.indexOf(c, i + 1);
          if (e > i + 1 && e < b) { html += "<em>"; span(i + 1, e); html += "</em>"; i = e + 1; continue; }
        }
        if (c === "`") {
          const e = s.indexOf("`", i + 1);
          if (e > i + 1 && e < b) { html += "<code>"; run(i + 1, e); html += "</code>"; i = e + 1; continue; }
        }
        put(c, i); i++;
      }
    }
    span(0, s.length);
    return html;
  }

  let para = "", paraEnd = 0, paraAttr = "", list: string | null = null;
  const flush = () => { if (para) { emit(`<p data-b="${nextB()}"${paraAttr}>${para}</p>`, paraEnd); para = ""; paraAttr = ""; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], off = lineAt[i];

    const fence = breaks && ln.match(/^\s*```/);
    if (fence) {
      flush(); closeList();
      let j = i + 1; const body: number[] = [];
      while (j < lines.length && !/^\s*```/.test(lines[j])) body.push(j++);
      let html = "";
      body.forEach((k, n) => {
        if (n) { html += "\n"; map.push(lineAt[k] - 1); }       // the newline is rendered text inside <pre>
        for (let c = 0; c < lines[k].length; c++) { html += esc(lines[k][c]); map.push(lineAt[k] + c); }
      });
      const last = body.length ? body[body.length - 1] : i;
      emit(`<pre data-b="${nextB()}"><code>${html}</code></pre>`, lineAt[last] + lines[last].length);
      i = j;
      continue;
    }

    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush(); closeList();
      const level = Math.min(h[1].length, 3), body = h[2], bo = off + ln.length - body.length;
      const num = headingNum(body);
      const slug = slugOf(body);
      const slugAttr = slug ? ` data-slug="${slug}"` : "";
      const html = num
        ? `<h${level} data-b="${nextB()}" data-sec="${num[0]}"${slugAttr}><span class="num">${inline(num[0], bo, true)}</span>${inline(num[2], bo + num[0].length + num[1].length, true)}</h${level}>`
        : `<h${level} data-b="${nextB()}"${slugAttr}>${inline(body, bo, true)}</h${level}>`;
      emit(html, bo + body.length);
      continue;
    }

    const li = ln.match(/^(\s*)([-*]|\d+\.)(\s+)(.*)$/);
    if (li) {
      const kind = /^\d/.test(li[2]) ? "ol" : "ul";
      flush();
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      const bo = off + li[1].length + li[2].length + li[3].length;
      emit(`<li data-b="${nextB()}">${inline(li[4], bo, true)}</li>`, bo + li[4].length);
      continue;
    }

    if (!ln.trim()) { flush(); closeList(); continue; }

    // A transcript paragraph may open with a "[41:20]" timestamp, which cards anchor to.
    let body = ln, bo = off; const first = !para;
    if (first) {
      const ts = ln.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/);
      if (ts) {
        paraAttr = ` data-ts="${ts[1]}"`;
        para = `<span class="ts">${inline(ts[1], off + 1, true)}</span>`;
        body = ln.slice(ts[0].length); bo = off + ts[0].length;
      }
    }
    if (breaks) {
      if (!first) { para += "<br/>"; }                            // the newline you typed is a break you meant
      para += inline(body, bo, true);
      paraEnd = off + ln.length;
    } else {
      const lead = body.length - body.trimStart().length, txt = body.trim();
      if (!first) { para += " "; map.push(off - 1); }             // hard-wrapped source: reflow
      para += inline(txt, bo + lead, first);
      paraEnd = bo + lead + txt.length;
    }
  }
  flush(); closeList();
  return { html: out.join("\n"), maps };
}

export const mdToHtml = (text: string | null | undefined, breaks: boolean): string => mdRender(text, breaks).html;

// Exported so tests can fuzz the same parser config cards use; pasted input must never hang or throw.
export const MD_OPTIONS = { forceBlock: true, enforceAtxHeadings: true, disableParsingRawHTML: true } as const;

