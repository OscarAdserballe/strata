import { Extension, Node, type JSONContent } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { imageRefOf, shownSrc } from "./images.ts";

// Only the room's own images come in from pasted HTML: anything else would be fetched from elsewhere on every view.
const roomImage = (roomUrl: (id: string) => string) => Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: { default: null, parseHTML: (el: HTMLElement) => imageRefOf(el.getAttribute("src")), renderHTML: (a: { src?: string | null }) => ({ src: shownSrc(a.src, roomUrl) }) },
    };
  },
  parseHTML() { return [{ tag: "img[src]", getAttrs: (el: HTMLElement) => (imageRefOf(el.getAttribute("src")) ? null : false) }]; },
}).configure({ inline: true, HTMLAttributes: { class: "strata-img", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" } });

// Raw HTML is text in notes, as Review draws it; marked would otherwise hand it to the schema as marks.
const TAG = /^(?:<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->)/;
const HtmlAsText = Extension.create({
  name: "htmlText",
  markdownTokenizer: { name: "htmlText", level: "inline", start: (src: string) => src.indexOf("<"),
    tokenize: (src: string) => { const m = TAG.exec(src); return m ? { type: "htmlText", raw: m[0], text: m[0] } : undefined; } },
  parseMarkdown: (token: { text?: string }) => ({ type: "text", text: token.text ?? "" }),
});
const HtmlBlockAsText = Extension.create({
  name: "htmlBlockText",
  markdownTokenName: "html",
  parseMarkdown: (token: { raw?: string }) => ({ type: "paragraph", content: token.raw?.trim() ? [{ type: "text", text: token.raw.replace(/\n+$/, "") }] : [] }),
});

const OneLine = Node.create({ name: "doc", topNode: true, content: "paragraph" });
export const lineDoc = (text: string): JSONContent => ({ type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] });

const NONE = { blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false, heading: false, horizontalRule: false, italic: false, listItem: false,
  listKeymap: false, orderedList: false, strike: false, link: false, hardBreak: false, dropcursor: false, gapcursor: false } as const;
export const extensionsFor = (line: boolean, placeholder: string, roomUrl: (id: string) => string) => line
  ? [StarterKit.configure({ ...NONE, document: false, underline: false, trailingNode: false }), OneLine, Placeholder.configure({ placeholder })]
  : [StarterKit.configure({ underline: false, trailingNode: false, link: { openOnClick: false, autolink: true, HTMLAttributes: { target: "_blank", rel: "noopener" } } }),
      roomImage(roomUrl), HtmlAsText, HtmlBlockAsText, Markdown, Placeholder.configure({ placeholder })];
