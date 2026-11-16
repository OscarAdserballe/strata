export const KINDLE_NOTEBOOK = "https://read.amazon.com/notebook";

export const KINDLE_PROMPT = `Below are my Kindle highlights for one book, copied from read.amazon.com/notebook. Put them in Strata for me:

1. Ask me which board they go on if I haven't said, and call whoami to find its handle.
2. Write one Markdown file named after the book: the title as the top heading, a ## heading per chapter in the book's order, each highlight as a > quote, and my note (if any) as a line under it. Keep the highlights' words exactly as copied.
3. Read get_guide({ topic: "uploads" }), then upload the file with request_upload, with origin { from: "kindle", ref: "<book title>" }. The same title again replaces the page in place and keeps its cards, so later highlights are added by sending the whole book again.
4. Call get_outline on the new source to find its sections, then apply one add_deck per chapter: one card per highlight, asking about what the highlight says, with at set to 4 to 40 consecutive words copied verbatim from that highlight.

My highlights:
`;
