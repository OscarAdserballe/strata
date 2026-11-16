import "./writer.css";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { mergeAttributes } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { imageSrc } from "../../engines/prose/images.tsx";
import { imagesIn, uploadImage } from "../attach/attach.ts";
import { toast } from "../../shell/layers.ts";

// The stored text keeps the room's `img:<id>` token; only the page draws it from the image route.
const RoomImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const src = String(HTMLAttributes.src ?? "");
    const id = /^img:([0-9a-f]{16})$/.exec(src)?.[1];
    const drawn = id ? imageSrc(id) : /^https?:\/\//.test(src) ? src : "";
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: drawn, loading: "lazy", referrerpolicy: "no-referrer" })];
  },
});

const extensions = [
  StarterKit.configure({ link: { openOnClick: true, autolink: true, HTMLAttributes: { target: "_blank", rel: "noopener" } } }),
  RoomImage.configure({ inline: false, allowBase64: false }),
  Markdown,
];

export interface WriterProps {
  /** Markdown, as stored. */
  value: string;
  /** Called with the Markdown after each change; without it the text is read-only. */
  onChange?(md: string): void;
  onFocus?(): void;
  onBlur?(): void;
  /** Return true to take the key from the editor (Escape to leave, say). */
  onKey?(e: KeyboardEvent): boolean;
  label: string;
  placeholder?: string;
  className?: string;
  id?: string;
  autoFocus?: boolean;
}

// Outside text replaces what is shown only while unfocused, so a save's answer never moves the caret.
export default function Writer({ value, onChange, onFocus, onBlur, onKey, label, placeholder, className, id, autoFocus }: WriterProps) {
  const cb = useRef({ onChange, onFocus, onBlur, onKey });
  cb.current = { onChange, onFocus, onBlur, onKey };
  const shown = useRef(value);
  const edRef = useRef<Editor | null>(null);
  // one options object for the editor's life: a fresh one each render makes Tiptap re-apply them all
  const [options] = useState(() => ({
    extensions,
    content: value,
    contentType: "markdown" as const,
    editable: !!onChange,
    autofocus: autoFocus ? ("end" as const) : false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { "aria-label": label, ...(id ? { id } : {}), ...(onChange ? { "aria-multiline": "true", role: "textbox" } : {}) },
      handleKeyDown: (_v: unknown, e: KeyboardEvent) => !!cb.current.onKey?.(e),
      handlePaste: (_v: unknown, e: ClipboardEvent) => attach(edRef.current, imagesIn(e.clipboardData), null),
      handleDrop: (view: EditorView, e: DragEvent) => {
        const files = imagesIn(e.dataTransfer);
        const at = files.length ? view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null : null;
        return attach(edRef.current, files, at);
      },
    },
    onUpdate: ({ editor: ed }: { editor: Editor }) => { const md = ed.getMarkdown().replace(/\n+$/, ""); shown.current = md; cb.current.onChange?.(md); },
    onFocus: () => cb.current.onFocus?.(),
    onBlur: () => cb.current.onBlur?.(),
  }));
  const editor = useEditor(options);
  edRef.current = editor;
  useEffect(() => {
    if (!editor || editor.isFocused || value === shown.current) return;
    shown.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);
  useEffect(() => { editor?.setEditable(!!onChange, false); }, [editor, !!onChange]);
  const empty = !value.trim();
  return <div className={"writer md" + (className ? ` ${className}` : "") + (empty ? " blank" : "")}
    // a press on the field's padding, below the last line, writes at the end rather than nowhere
    onMouseDown={(e) => { if (e.target === e.currentTarget && editor?.isEditable) { e.preventDefault(); editor.commands.focus("end"); } }}>
    {empty && placeholder ? <span className="writer-ph" aria-hidden="true">{placeholder}</span> : null}
    <EditorContent editor={editor} />
  </div>;
}

// false when nothing was an image, so the editor takes the paste as text
function attach(editor: Editor | null, files: File[], at: number | null): boolean {
  if (!editor || !files.length || !editor.isEditable) return false;
  toast(files.length === 1 ? "Uploading the image…" : `Uploading ${files.length} images…`);
  void (async () => {
    for (const f of files) {
      try {
        const img = await uploadImage(f);
        const chain = editor.chain();
        (at === null ? chain.focus() : chain.focus().setTextSelection(at)).setImage({ src: `img:${img.id}` }).run();
        at = null;
      } catch (e) {
        toast(`Couldn’t add that image — ${(e as Error | null)?.message || "try again"}`, 4200);
        return;
      }
    }
  })();
  return true;
}
