import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { mergeAttributes } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { imageSrc } from "../../engines/prose/images.tsx";
import { toast } from "../../shell/layers.ts";
import { imagesIn, uploadImage } from "../attach/attach.ts";

const STORED = /^img:([0-9a-f]{16})$/;
const SERVED = /\/api\/images\/([0-9a-f]{16})$/;

// The document keeps the stored ref (img:<id>) so Markdown round-trips untouched; only the drawn <img> points at the server.
const StoredImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: { default: null, parseHTML: (el) => { const s = el.getAttribute("src") ?? ""; const m = SERVED.exec(s); return m ? `img:${m[1]}` : s; } },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const id = STORED.exec(String(HTMLAttributes.src ?? ""))?.[1];
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, id ? { src: imageSrc(id) } : {})];
  },
}).configure({ inline: true, HTMLAttributes: { class: "strata-img", referrerpolicy: "no-referrer" } });

function place(view: EditorView, files: File[], at: number | null): void {
  toast(files.length === 1 ? "Uploading the image…" : `Uploading ${files.length} images…`);
  void (async () => {
    for (const f of files) {
      let id: string;
      try { id = (await uploadImage(f)).id; } catch (e) { toast(`Couldn’t add that image: ${(e as Error | null)?.message || "try again"}`, 4200); return; }
      if (view.isDestroyed) return;
      const { state } = view;
      const pos = Math.min(at ?? state.selection.to, state.doc.content.size);
      view.dispatch(state.tr.insert(pos, state.schema.nodes.image.create({ src: `img:${id}` })).scrollIntoView());
      at = null;
    }
  })();
}

export interface WriterProps {
  value: string;
  onChange(markdown: string): void;
  label: string;
  placeholder?: string;
  className?: string;
  id?: string;
  autoFocus?: boolean;
  onFocus?(): void;
  onBlur?(): void;
  onEscape?(): void;
}

// Reads `value` only while you are out of it and reports only your edits: opening a note never rewrites it, a save never moves the caret.
export default function Writer(p: WriterProps) {
  const shown = useRef(p.value);
  const on = useRef(p);
  on.current = p;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true }, trailingNode: false }),
      StoredImage,
      Markdown,
      Placeholder.configure({ placeholder: p.placeholder ?? "" }),
    ],
    content: p.value,
    contentType: "markdown",
    autofocus: p.autoFocus ? "end" : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: `writer md ${p.className ?? ""}`, role: "textbox", "aria-multiline": "true", "aria-label": p.label, ...(p.id ? { id: p.id } : {}) },
      // clear of the sticky footer below a long doc, so the line you type at stays in sight
      scrollMargin: { top: 24, bottom: 112, left: 0, right: 0 },
      scrollThreshold: { top: 24, bottom: 112, left: 0, right: 0 },
      handlePaste: (view, e) => { const files = imagesIn(e.clipboardData); if (!files.length) return false; place(view, files, null); return true; },
      handleDrop: (view, e, _slice, moved) => {
        const files = moved ? [] : imagesIn(e.dataTransfer);
        if (!files.length) return false;
        place(view, files, view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null);
        return true;
      },
      handleKeyDown: (_view, e) => { if (e.key === "Escape" && on.current.onEscape) { on.current.onEscape(); return true; } return false; },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.getMarkdown();
      if (md === shown.current) return;
      shown.current = md;
      on.current.onChange(md);
    },
    onFocus: () => on.current.onFocus?.(),
    onBlur: () => on.current.onBlur?.(),
  });
  // another device's edit lands while you are elsewhere; while you type, the editor is the truth
  useEffect(() => {
    if (!editor || editor.isFocused || p.value === shown.current) return;
    shown.current = p.value;
    editor.commands.setContent(p.value, { contentType: "markdown", emitUpdate: false });
  }, [p.value, editor]);
  return <EditorContent editor={editor} />;
}
