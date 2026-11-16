// The Writer's editor: Tiptap over the room's Markdown, a chunk that imports nothing of the app so the room's chunks stay as they are.
import { Editor, Extension, InputRule } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { converter, schemaExtensions } from "./markdown.ts";

export interface Mount {
  value: string;
  label: string;
  placeholder: string;
  className: string;
  id?: string;
  onChange(markdown: string): void;
  onFocus(): void;
  onBlur(): void;
  onKeyDown(e: KeyboardEvent): void;
  say(status: string): void;
  // the room's image path, handed in rather than imported
  images: { of(data: DataTransfer | null): File[]; drags(data: DataTransfer | null): boolean; upload(f: File): Promise<{ id: string }>; src(id: string): string };
}
export interface Writing { take(markdown: string): void; flush(): void; destroy(): void }

const REF = /^img:([0-9a-f]{16})$/;
const SERVED = /\/api\/images\/([0-9a-f]{16})$/;
const SETTLE_MS = 120;

/** An image is the room's: `img:<id>` in the Markdown, drawn from /api/images; any other <img> pasted in is left out. */
const roomImage = (src: (id: string) => string) => Image.extend({
  parseHTML() {
    return [{ tag: "img[src]", getAttrs: (el) => {
      const s = el.getAttribute("src") ?? "", id = SERVED.exec(s)?.[1] ?? REF.exec(s)?.[1];
      return id ? { src: `img:${id}`, alt: el.getAttribute("alt") || null } : false;
    } }];
  },
  renderHTML({ HTMLAttributes }) {
    const id = REF.exec(String(HTMLAttributes.src ?? ""))?.[1];
    return ["img", { ...HTMLAttributes, src: id ? src(id) : HTMLAttributes.src, class: "strata-img", decoding: "async", referrerpolicy: "no-referrer" }];
  },
});

// "- " typed at the start of a list item, from a textarea habit, is the bullet that is already there
const ListHabit = Extension.create({
  name: "listHabit",
  addInputRules() {
    return [new InputRule({ find: /^\s*([-+*]|\d+\.)\s$/, handler: ({ state, range, match }) => {
      const $at = state.doc.resolve(range.from);
      if ($at.depth < 3 || $at.node(-1).type.name !== "listItem" || $at.index(-1) !== 0) return null;
      if ($at.node(-2).type.name !== (/\d/.test(match[1]) ? "orderedList" : "bulletList")) return null;
      state.tr.delete(range.from, range.to);
    } })];
  },
});

// an empty doc still has a line to type on, or the caret lands in a gap before nothing
const fromMarkdown = (md: string) => { const doc = converter().parse(md); return doc.content?.length ? doc : { type: "doc", content: [{ type: "paragraph" }] }; };

export function mount(el: HTMLElement, o: Mount): Writing {
  let last = o.value, timer = 0;
  const settle = () => {
    clearTimeout(timer);
    timer = 0;
    const md = converter().serialize(ed.getJSON());
    if (md !== last) { last = md; o.onChange(md); }
  };

  function attach(files: File[], at: number, e: Event): boolean {
    if (!files.length) return false;
    e.preventDefault();
    e.stopPropagation();
    o.say(files.length === 1 ? "Uploading image…" : `Uploading ${files.length} images…`);
    let pos = at;
    const follow = ({ transaction }: { transaction: { mapping: { map(p: number): number } } }) => { pos = transaction.mapping.map(pos); };
    ed.on("transaction", follow);
    void (async () => {
      try {
        for (const f of files) {
          const img = await o.images.upload(f);
          if (ed.isDestroyed) return;
          // the caret goes on after the image, into a new last line if the image ended the doc
          ed.chain().insertContentAt(pos, { type: "image", attrs: { src: `img:${img.id}` } }).command(({ tr }) => {
            if (!(tr.selection instanceof NodeSelection)) return true;
            const after = tr.selection.to;
            if (after === tr.doc.content.size) tr.insert(after, tr.doc.type.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
            return true;
          }).run();
        }
        o.say("");
      } catch (err) {
        o.say(`Couldn’t attach that image: ${(err as Error | null)?.message || "try again"}`);
      } finally { ed.off("transaction", follow); }
    })();
    return true;
  }

  const ed: Editor = new Editor({
    element: el,
    extensions: [...schemaExtensions(roomImage(o.images.src)), ListHabit],
    content: fromMarkdown(o.value),
    editorProps: {
      attributes: (state) => ({
        class: `wr md ${o.className}`.trim(),
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": o.label,
        ...(o.id ? { id: o.id } : {}),
        "data-placeholder": o.placeholder,
        "data-empty": String(state.doc.childCount === 1 && state.doc.firstChild!.isTextblock && !state.doc.firstChild!.content.size),
      }),
      // the sticky footer covers the bottom of the sheet: keep the caret clear of it
      scrollMargin: { top: 24, bottom: 120, left: 0, right: 0 },
      scrollThreshold: { top: 24, bottom: 120, left: 0, right: 0 },
      handleKeyDown: (_view, e) => { if (e.key === "Escape" && timer) settle(); o.onKeyDown(e); return e.defaultPrevented; },
      handlePaste: (view, e) => attach(o.images.of(e.clipboardData), view.state.selection.from, e),
      handleDrop: (view, e, _slice, moved) => {
        if (moved || !o.images.drags(e.dataTransfer)) return false;
        return attach(o.images.of(e.dataTransfer), view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? view.state.selection.from, e);
      },
    },
    onUpdate: () => { clearTimeout(timer); timer = window.setTimeout(settle, SETTLE_MS); },
    onFocus: () => o.onFocus(),
    onBlur: () => { if (timer) settle(); o.onBlur(); },
  });

  return {
    // the server's copy is taken only while you are not writing here; useTyped holds what you typed until then
    take(md) { if (md === last || ed.isFocused) return; last = md; ed.commands.setContent(fromMarkdown(md), { emitUpdate: false }); },
    flush() { if (timer) settle(); },
    destroy() { if (timer) settle(); ed.destroy(); },
  };
}
