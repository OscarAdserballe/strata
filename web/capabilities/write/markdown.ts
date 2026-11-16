// What the Writer edits, as Markdown: the server and agents keep text, so every field is stored as Markdown.
import type { AnyExtension, JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { MarkdownManager } from "@tiptap/markdown";

/** The schema both the editor and the converter use; Markdown has no underline, and a trailing node would edit on load. */
export const schemaExtensions = (image: AnyExtension = Image): AnyExtension[] => [
  StarterKit.configure({ underline: false, trailingNode: false, link: { openOnClick: false, HTMLAttributes: { target: "_blank", rel: "noopener" } } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  image,
];

type Encode = (text: string, node: JSONContent, parent?: JSONContent) => string;
interface Escaping { encodeTextForMarkdown: Encode }

/** Escapes only what could read as syntax: `_` at a word's edge, `<` opening a tag, `&` naming an entity. */
const light = (text: string): string => text
  .replace(/([\\`*[\]~])/g, "\\$1")
  .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace("_", "\\_"))
  .replace(/<(?=[A-Za-z/!?])/g, "&lt;")
  .replace(/&(?=#?\w+;)/g, "&amp;");

// a bare URL was an autolink, and goes back bare rather than as [url](url)
const bareLinks = (md: string): string => md.replace(/\[(https?:\/\/[^\s\]]+)\]\(\1\)/g, "$1");

export class Converter {
  private readonly full: MarkdownManager;
  private readonly tiers: MarkdownManager[];
  constructor(extensions: AnyExtension[]) {
    this.full = new MarkdownManager({ extensions });
    const variant = (encode: (text: string) => string) => {
      const m = new MarkdownManager({ extensions });
      const own = (m as unknown as Escaping).encodeTextForMarkdown.bind(m);
      // the library leaves text in code as it is, and so does every tier
      (m as unknown as Escaping).encodeTextForMarkdown = (text, node, parent) => own("`", node, parent) === "`" ? text : encode(text);
      return m;
    };
    this.tiers = [variant((t) => t), variant(light)];
  }

  parse(md: string): JSONContent { return this.full.parse(md); }

  /** The least-escaped Markdown that reads back as the same document, so plain text stays as it was typed. */
  serialize(doc: JSONContent): string {
    const safe = this.full.serialize(doc);
    const meant = JSON.stringify(this.full.parse(safe));
    for (const m of this.tiers) {
      const out = bareLinks(m.serialize(doc));
      if (out === safe || JSON.stringify(this.full.parse(out)) === meant) return out;
    }
    return safe;
  }
}

let shared: Converter | null = null;
export const converter = (): Converter => (shared ??= new Converter(schemaExtensions()));
