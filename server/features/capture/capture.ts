import { envGet, fetchWithTimeout } from "../../platform/llm/llm.ts";

export const TAVILY_KEY = envGet("TAVILY_API_KEY");
export const FIRECRAWL_KEY = envGet("FIRECRAWL_API_KEY");
const FIRECRAWL_URL = (envGet("FIRECRAWL_API_URL") || "https://api.firecrawl.dev").replace(/\/+$/, "");
export const captureAvailable = !!(TAVILY_KEY || FIRECRAWL_KEY);

export type Fetcher = typeof fetchWithTimeout;

export function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
export function isYouTube(url: string): boolean {
  return /(?:youtube\.com\/(?:watch\?|shorts\/|live\/)|youtu\.be\/)/.test(url);
}
export function isHttpUrl(url: string): boolean {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

// --impersonate chrome dodges YouTube's 429 throttle; "en-orig,en" avoids the junk en-en-US variant.
export function ytDlpCommand(url: string, platform: "macos" | "windows" = "macos"): string {
  // URLs are shell data: even a valid URL may contain quotes or command substitutions.
  const quoted = platform === "windows" ? `'${url.replaceAll("'", "''")}'` : `'${url.replaceAll("'", "'\\''")}'`;
  if (platform === "windows") return `$d = Join-Path ([IO.Path]::GetTempPath()) ("strata-" + [guid]::NewGuid())
$dir = New-Item -ItemType Directory -Path $d -ErrorAction Stop
try {
    yt-dlp --impersonate chrome --skip-download --write-auto-subs --sub-langs "en-orig,en" --sub-format vtt -o "$d/c.%(ext)s" ${quoted}
    if ($LASTEXITCODE -ne 0) { throw "Caption download failed. See the error above." }
    $sub = Get-ChildItem -LiteralPath $dir.FullName -Filter "c*.vtt" | Sort-Object Name | Select-Object -First 1
    if (-not $sub) { throw "No English captions found." }
    Get-Content -LiteralPath $sub.FullName -Raw -Encoding UTF8 | Set-Clipboard -ErrorAction Stop
    Write-Host "Captions copied - paste them into Strata."
} finally {
    Remove-Item -LiteralPath $dir.FullName -Recurse -Force
}`;
  return `(
d=$(mktemp -d) || exit 1
trap 'rm -rf -- "$d"' EXIT
yt-dlp --impersonate chrome --skip-download --write-auto-subs --sub-langs en-orig,en --sub-format vtt -o "$d/c.%(ext)s" ${quoted} || exit 1
sub="$d/c.en-orig.vtt"
[ -f "$sub" ] || sub="$d/c.en.vtt"
[ -f "$sub" ] || { echo "No English captions found."; exit 1; }
pbcopy < "$sub" && echo "Captions copied - paste them into Strata."
)`;
}

export interface OembedInfo { title?: string; author?: string }
export async function fetchOembed(url: string, f: Fetcher = fetchWithTimeout): Promise<OembedInfo> {
  try {
    const r = await f(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { timeout: 10_000 });
    if (!r.ok) return {};
    const j = (await r.json()) as { title?: string; author_name?: string };
    return { title: j.title, author: j.author_name };
  } catch { return {}; }
}

export interface ArticleInfo { title: string; author: string; text: string }

const unlink = (s: string): string => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

// The first h1 wins over earlier h2/h3: what precedes an article's own title is site chrome.
export function firstHeading(md: string): string | undefined {
  const head = md.split("\n").slice(0, 40);
  const clean = (s: string) => unlink(s).replace(/[*_`#]/g, "").trim();
  let fallback: string | undefined;
  for (const line of head) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (!m) continue;
    const text = clean(m[2]);
    if (!text) continue;
    if (m[1] === "#") return text;
    if (fallback === undefined) fallback = text;
  }
  return fallback;
}

export function stripSiteSuffix(title: string, site: string): string {
  const s = site.trim();
  if (!s) return title;
  const m = title.match(/^(.*\S)\s+[-–—|·]\s+([^-–—|·]+)$/);
  if (!m) return title;
  const norm = (x: string) => x.toLowerCase().replace(/\.(com|org|net|io|co|ca|uk|dev|ai)$/, "").replace(/[^a-z0-9]/g, "");
  const tail = norm(m[2]);
  return tail && tail === norm(s) ? m[1].trim() : title;
}

// Repairs two extractor seams: sidenotes glued as "word.Next", and images sharing a line with prose.
const IMG = /!\[[^\]]*\]\([^)]*\)/;
const wholeImage = new RegExp(`^\\s*(?:${IMG.source}|\\[${IMG.source}\\]\\([^)]*\\))\\s*$`);
const leadingImage = new RegExp(`^(\\s*(?:${IMG.source}|\\[${IMG.source}\\]\\([^)]*\\)))\\s*(\\S.*)$`);

export function healSeams(line: string): string {
  return line.split(" ").map((w) =>
    /[`(]|:\/\/|\]\(/.test(w) ? w : w.replace(/([a-z]{2})\.([A-Z][a-z])/g, "$1. $2"),
  ).join(" ");
}

export function normalizeExtract(md: string): string {
  const out: string[] = [];
  let fenced = false;
  for (let ln of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(ln)) { fenced = !fenced; out.push(ln); continue; }
    if (fenced) { out.push(ln); continue; }
    // A link butted against a capital is always an extractor seam; healSeams skips link-bearing words.
    ln = ln.replace(/(\]\([^)]*\))(?=[A-Z])/g, "$1 ");
    const lead = ln.match(leadingImage);
    if (lead) { out.push("", lead[1], ""); ln = lead[2]; }
    else if (wholeImage.test(ln)) { out.push("", ln, ""); continue; }
    out.push(healSeams(ln));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

// Tavily returns images beside its Markdown; append only those it did not already reference.
export function appendMissingImages(md: string, images: unknown): string {
  if (!Array.isArray(images)) return md;
  const missing: string[] = [], seen = new Set<string>();
  for (const value of images) {
    const url = typeof value === "string" ? value.trim() : "";
    if (!isHttpUrl(url) || seen.has(url) || md.includes(url)) continue;
    seen.add(url); missing.push(url);
  }
  if (!missing.length) return md;
  const newline = md.endsWith("\n") ? "\n" : "";
  return `${md.trimEnd()}\n\n${missing.map((url) => `![](${url})`).join("\n\n")}${newline}`;
}

async function fetchArticleTavily(url: string, f: Fetcher): Promise<ArticleInfo> {
  if (!TAVILY_KEY) throw new Error("TAVILY_API_KEY not configured");
  const r = await f("https://api.tavily.com/extract", {
    method: "POST", timeout: 60_000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
    body: JSON.stringify({ urls: url, format: "markdown", extract_depth: "advanced", include_images: true }),
  });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
  const j = (await r.json()) as { results?: { raw_content?: string; images?: string[] }[]; failed_results?: { error?: string }[] };
  const result = j.results?.[0];
  const text = appendMissingImages((result?.raw_content ?? "").trim(), result?.images);
  if (!text) throw new Error(`Tavily returned no content${j.failed_results?.[0]?.error ? `: ${j.failed_results[0].error}` : ""}`);
  return { title: firstHeading(text) ?? hostname(url), author: hostname(url), text };
}

async function fetchArticleFirecrawl(url: string, f: Fetcher): Promise<ArticleInfo> {
  if (!FIRECRAWL_KEY) throw new Error("FIRECRAWL_API_KEY not configured");
  const r = await f(`${FIRECRAWL_URL}/v1/scrape`, {
    method: "POST", timeout: 60_000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRECRAWL_KEY}` },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  if (!r.ok) throw new Error(`Firecrawl HTTP ${r.status}`);
  const data = ((await r.json()) as { data?: { markdown?: string; metadata?: Record<string, string> } }).data ?? {};
  const md = (data.markdown ?? "").trim();
  if (!md) throw new Error("Firecrawl returned no content");
  const meta = data.metadata ?? {};
  const site = meta.ogSiteName || hostname(url);
  const raw = meta.title || meta.ogTitle || firstHeading(md) || hostname(url);
  return { title: stripSiteSuffix(raw, site), author: meta.author || meta.ogSiteName || hostname(url), text: md };
}

// Firecrawl first: it returns the page's own title and drops nav; Tavily's title is only a guess.
export async function fetchArticle(url: string, f: Fetcher = fetchWithTimeout): Promise<ArticleInfo> {
  const errors: string[] = [];
  const clean = (a: ArticleInfo): ArticleInfo => ({ ...a, text: normalizeExtract(a.text) });
  if (FIRECRAWL_KEY) {
    try { return clean(await fetchArticleFirecrawl(url, f)); }
    catch (e) { errors.push(`firecrawl: ${e instanceof Error ? e.message : "failed"}`); }
  }
  if (TAVILY_KEY) {
    try { return clean(await fetchArticleTavily(url, f)); }
    catch (e) { errors.push(`tavily: ${e instanceof Error ? e.message : "failed"}`); }
  }
  throw new Error(errors.length ? errors.join(" | ") : "no article fetcher configured (set TAVILY_API_KEY or FIRECRAWL_API_KEY)");
}

// YouTube auto-captions roll (each cue repeats the previous line), so cues are deduped and merged.
const PARA_SECONDS = 45;
const PARA_CHARS = 700;

export function vttToShort(ts: string): string {
  const m = ts.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return ts.replace(/\.\d+$/, "");
  const h = parseInt(m[1], 10);
  return h > 0 ? `${h}:${m[2]}:${m[3]}` : `${parseInt(m[2], 10)}:${m[3]}`;
}
function vttSeconds(ts: string): number {
  const m = ts.match(/(\d{2}):(\d{2}):(\d{2})/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

// Captions arrive HTML-escaped (YouTube's ">>" speaker marker comes through as "&gt;&gt;").
export const decodeEntities = (s: string): string => s
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export interface Cue { at: string; seconds: number; text: string }
export function parseVtt(vtt: string): Cue[] {
  const out: Cue[] = [];
  let last = "";
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const tsIdx = lines.findIndex((l) => l.includes("-->"));
    if (tsIdx < 0) continue;
    const start = lines[tsIdx].split("-->")[0].trim().split(/\s+/)[0];
    const text = lines.slice(tsIdx + 1)
      .map((l) => decodeEntities(l.replace(/<[^>]+>/g, "")).trim())
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    // A cue we already have is dropped; one extending the previous line replaces it, keeping its timestamp.
    if (text === last || (last && last.includes(text))) continue;
    if (last && text.startsWith(last)) { out[out.length - 1].text = text; last = text; continue; }
    out.push({ at: vttToShort(start), seconds: vttSeconds(start), text });
    last = text;
  }
  return out;
}

// Drop the longest suffix of the previous cue that opens this one; two words minimum.
export function dropOverlap(prev: string, next: string): string {
  if (!prev || !next) return next;
  const p = prev.split(" "), n = next.split(" ");
  for (let k = Math.min(p.length, n.length); k >= 2; k--) {
    if (p.slice(p.length - k).join(" ") === n.slice(0, k).join(" ")) return n.slice(k).join(" ");
  }
  return next;
}

export function cuesToParagraphs(cues: Cue[]): string[] {
  const paras: string[] = [];
  let at = "", body: string[] = [], startedAt = 0, prev = "";
  const flush = () => { if (body.length) paras.push(`[${at}] ${body.join(" ")}`); body = []; };
  for (const c of cues) {
    const text = dropOverlap(prev, c.text).trim();
    prev = c.text;
    if (!text) continue;
    if (body.length && (c.seconds - startedAt >= PARA_SECONDS || body.join(" ").length >= PARA_CHARS)) flush();
    if (!body.length) { at = c.at; startedAt = c.seconds; }
    body.push(text);
  }
  flush();
  return paras;
}

interface TalkMeta { title: string; author?: string; uploaded?: string; url: string }
const talkMarkdown = (m: TalkMeta, paras: string[]): string =>
  `# ${m.title}\n\n*${[m.author, m.uploaded, m.url].filter(Boolean).join(" · ")}*\n\n${paras.join("\n\n")}\n`;

export function transcriptToMarkdown(vtt: string, meta: TalkMeta): { text: string; cues: number } {
  const cues = parseVtt(vtt);
  return { text: talkMarkdown(meta, cuesToParagraphs(cues)), cues: cues.length };
}

export interface VideoInfo { title: string; author?: string; uploaded?: string; lines: string[] }
export class NoTranscript extends Error {
  readonly video: VideoInfo;
  constructor(video: VideoInfo) { super("YouTube shows no transcript for this video"); this.video = video; }
}

const headerField = (head: string[], name: string): string | undefined => {
  const prefix = `**${name}**:`;
  const line = head.find((l) => l.startsWith(prefix));
  return line ? unlink(line.slice(prefix.length)).trim() || undefined : undefined;
};

// Firecrawl renders a watch page as a header (# title, **Uploaded by**, **Uploaded at**) and then "## Transcript".
export function parseYouTubeScrape(md: string): VideoInfo {
  const all = md.replace(/\r\n/g, "\n").split("\n");
  const found = all.findIndex((l) => /^##\s+Transcript\s*$/.test(l));
  const at = found < 0 ? all.length : found;
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  const lines = (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter(Boolean);
  const head = all.slice(0, at);
  return { title: firstHeading(head.join("\n")) ?? "", author: headerField(head, "Uploaded by"), uploaded: headerField(head, "Uploaded at"), lines };
}

// These caption lines carry no timestamps, so paragraphs break at a sentence end once they are long enough.
export function linesToParagraphs(lines: string[]): string[] {
  const paras: string[] = [];
  let body = "";
  for (const line of lines) {
    body = body ? `${body} ${line}` : line;
    if (body.length >= PARA_CHARS * 1.5 || (body.length >= PARA_CHARS && /[.!?…]["')\]]?$/.test(line))) { paras.push(body); body = ""; }
  }
  if (body) paras.push(body);
  return paras;
}

export const videoToMarkdown = (v: VideoInfo, url: string): string =>
  talkMarkdown({ title: v.title, author: v.author, uploaded: v.uploaded, url }, linesToParagraphs(v.lines));

// Without an action Firecrawl returns only YouTube's chrome; any action makes it render the transcript.
export async function fetchYouTubeTranscript(url: string, f: Fetcher = fetchWithTimeout): Promise<VideoInfo> {
  if (!FIRECRAWL_KEY) throw new Error("FIRECRAWL_API_KEY not configured");
  const r = await f(`${FIRECRAWL_URL}/v1/scrape`, {
    method: "POST", timeout: 150_000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRECRAWL_KEY}` },
    body: JSON.stringify({ url, formats: ["markdown"], actions: [{ type: "wait", milliseconds: 1000 }], timeout: 120_000 }),
  });
  if (!r.ok) throw new Error(`Firecrawl HTTP ${r.status}`);
  const data = ((await r.json()) as { data?: { markdown?: string; metadata?: Record<string, unknown> } }).data ?? {};
  const video = parseYouTubeScrape(data.markdown ?? "");
  const og = data.metadata?.ogTitle;
  if (!video.title && typeof og === "string") video.title = og;
  if (!video.lines.length) throw new NoTranscript(video);
  video.title ||= url;
  return video;
}

export function articleToMarkdown(a: ArticleInfo, url: string): string {
  const origin = `*${[a.author, url].filter(Boolean).join(" · ")}*`;
  const body = firstHeading(a.text) === a.title ? a.text : `# ${a.title}\n\n${a.text}`;
  const lines = body.split("\n");
  const firstHeadIdx = lines.findIndex((l) => /^#{1,3}\s+/.test(l));
  if (firstHeadIdx < 0) return `${origin}\n\n${body}\n`;
  lines.splice(firstHeadIdx + 1, 0, "", origin);
  return lines.join("\n") + "\n";
}

export const captureFilename = (title: string): string =>
  (title || "untitled").replace(/[\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
