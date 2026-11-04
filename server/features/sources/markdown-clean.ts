export type MarkdownCleanCall = (opts: {
  system: string;
  user: string;
  thinkingBudget?: number;
  timeoutMs?: number;
}) => Promise<unknown>;

export const MARKDOWN_CLEAN_SYSTEM = `You identify removable page chrome in Markdown imported from a web page or file.

You receive JSON with a "blocks" array. Each block has a numeric "id" and its original Markdown. Return the ids of blocks that consist entirely of page chrome or extraction debris: navigation, cookie notices, sign-in or subscribe prompts, standalone share buttons and social-sharing links, follow widgets, app promotions, related/recommended-post blocks, reader discussion sections (including the comments themselves and their author/date/reply metadata), and repeated site mastheads or footers.

Never remove a block containing any part of the document: its title, subtitle, byline, date, headings, substantive prose, quotes, lists, tables, code, math, footnotes, images, links used by the prose, or provenance. If chrome and document content share one block, keep the block. A document with no page chrome has no ids to remove.

At the top of a capture, a publication/site name and its navigation links are chrome when a separate document title follows them. Short acknowledgements or credit lines such as "h/t Name" are document content and must be kept.

Do not return or rewrite the Markdown. Return one JSON object with exactly this shape: {"remove":[1,4]}.`;

// Any failure (including empty or malformed output) keeps the original: some chrome beats losing a source.
export async function cleanImportedMarkdown(
  markdown: string,
  call?: MarkdownCleanCall,
  onError?: (error: unknown) => void,
): Promise<string> {
  if (!call || !markdown.trim()) return markdown;
  try {
    const blocks = markdown.trim().split(/\r?\n[ \t]*\r?\n+/);
    const out = await call({
      system: MARKDOWN_CLEAN_SYSTEM,
      user: JSON.stringify({ blocks: blocks.map((block, id) => ({ id, markdown: block })) }),
      thinkingBudget: 0,
      timeoutMs: 60_000,
    });
    const remove = out && typeof out === "object" ? (out as { remove?: unknown }).remove : undefined;
    if (!Array.isArray(remove) || !remove.every((id) => Number.isInteger(id) && id >= 0 && id < blocks.length)) return markdown;
    const gone = new Set(remove as number[]);
    if (!gone.size) return markdown;
    // A removed discussion heading takes the comments below it; the model misjudges some on their own.
    const discussion = [...gone].find((id) => /\b(?:discussion about this post|reader comments?|comments section)\b/i.test(blocks[id]));
    if (discussion !== undefined) for (let id = discussion; id < blocks.length; id++) gone.add(id);
    const kept = blocks.filter((_, id) => !gone.has(id));
    return kept.length ? `${kept.join("\n\n")}${markdown.endsWith("\n") ? "\n" : ""}` : markdown;
  } catch (error) {
    onError?.(error);
    return markdown;
  }
}
