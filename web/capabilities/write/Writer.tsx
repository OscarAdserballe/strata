import "./write.css";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { imagesIn, uploadImage } from "../attach/attach.ts";
import { imageSrc } from "../../engines/prose/images.tsx";
import { fromEditor, toEditor } from "./markdown.ts";

export interface WriterProps {
  value: string;
  onChange(md: string): void;
  onFocus?(): void;
  onBlur?(): void;
  onKeyDown?(e: KeyboardEvent): void;
  label?: string;
  placeholder?: string;
  /** on the editable element, so `.focus()` on it starts typing */
  className?: string;
  autoFocus?: boolean;
}

/** Where you write prose: one editor for every such field, Markdown in and out, marks by key, by typing them or from the bar, images by paste or drop. */
export default function Writer({ value, onChange, onFocus, onBlur, onKeyDown, label, placeholder = "", className = "", autoFocus = false }: WriterProps) {
  const [status, setStatus] = useState("");
  const [sel, setSel] = useState<{ top: number; left: number } | null>(null);
  const focused = useRef(false);
  const pressed = useRef(false);
  const last = useRef(value);
  const props = useRef({ onChange, onFocus, onBlur, onKeyDown });
  props.current = { onChange, onFocus, onBlur, onKeyDown };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: true, HTMLAttributes: { target: "_blank", rel: "noopener" } } }),
      Image.configure({ HTMLAttributes: { class: "strata-img", loading: "lazy", referrerpolicy: "no-referrer" } }),
      Markdown,
      Placeholder.configure({ placeholder }),
    ],
    content: toEditor(value),
    contentType: "markdown",
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: `writer ${className}`.trim(), role: "textbox", "aria-multiline": "true", ...(label ? { "aria-label": label } : {}) },
      handleDOMEvents: { mousedown: () => { pressed.current = true; return false; }, touchstart: () => { pressed.current = true; return false; } },
      handleKeyDown: (_view, e) => { props.current.onKeyDown?.(e); return false; },
      handlePaste: (_view, e) => attach(imagesIn(e.clipboardData)),
      handleDrop: (view, e) => {
        const files = imagesIn((e as DragEvent).dataTransfer);
        if (!files.length) return false;
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
        if (at !== undefined) editorRef.current?.commands.setTextSelection(at);
        return attach(files);
      },
    },
    onFocus: ({ editor: ed }) => {
      focused.current = true;
      // focus by script or Tab puts no caret where you'd type: a click places it, anything else starts at the end
      if (!pressed.current) ed.commands.setTextSelection(ed.state.doc.content.size);
      pressed.current = false;
      props.current.onFocus?.();
    },
    onBlur: () => { focused.current = false; setSel(null); props.current.onBlur?.(); },
    onUpdate: ({ editor: ed }) => { const md = fromEditor(ed.getMarkdown()); last.current = md; props.current.onChange(md); },
    onSelectionUpdate: ({ editor: ed }) => setSel(selectionBox(ed)),
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // take the stored text only while nobody is typing in it, so a save's answer never moves the caret
  useEffect(() => {
    if (!editor || focused.current || value === last.current) return;
    last.current = value;
    editor.commands.setContent(toEditor(value), { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  function attach(files: File[]): boolean {
    if (!files.length) return false;
    setStatus(files.length === 1 ? "Uploading the image…" : `Uploading ${files.length} images…`);
    void (async () => {
      for (const f of files) {
        try {
          const img = await uploadImage(f);
          editorRef.current?.chain().focus().setImage({ src: imageSrc(img.id), alt: "" }).run();
        } catch (e) { setStatus(`Couldn’t attach that image: ${(e as Error | null)?.message || "try again"}`); return; }
      }
      setStatus("");
    })();
    return true;
  }

  const mark = (name: "bold" | "italic" | "strike" | "code") => editor?.chain().focus().toggleMark(name).run();
  const link = () => {
    if (!editor) return;
    if (editor.isActive("link")) { editor.chain().focus().unsetLink().run(); return; }
    const href = prompt("Link to")?.trim();
    if (href) editor.chain().focus().setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run();
  };
  return <div className="writer-wrap">
    <EditorContent editor={editor} />
    {sel && editor ? <div className="writer-marks" role="toolbar" aria-label="Format" style={{ top: sel.top, left: sel.left }} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className={editor.isActive("bold") ? "on" : ""} onClick={() => mark("bold")} title="Bold (⌘B)"><b>B</b></button>
      <button type="button" className={editor.isActive("italic") ? "on" : ""} onClick={() => mark("italic")} title="Italic (⌘I)"><i>I</i></button>
      <button type="button" className={editor.isActive("strike") ? "on" : ""} onClick={() => mark("strike")} title="Strike (⌘⇧S)"><s>S</s></button>
      <button type="button" className={editor.isActive("code") ? "on" : ""} onClick={() => mark("code")} title="Code (⌘E)"><code>{"<>"}</code></button>
      <button type="button" className={editor.isActive("link") ? "on" : ""} onClick={link} title="Link">Link</button>
    </div> : null}
    {status ? <span className="writer-status" role="status">{status}</span> : null}
  </div>;
}

/** Where the marks bar sits: above a non-empty selection, relative to the editor's box. */
function selectionBox(ed: Editor): { top: number; left: number } | null {
  const { from, to, empty } = ed.state.selection;
  if (empty || !ed.isFocused) return null;
  const box = ed.view.dom.getBoundingClientRect();
  const a = ed.view.coordsAtPos(from), b = ed.view.coordsAtPos(to);
  return { top: Math.min(a.top, b.top) - box.top - 38, left: Math.max(0, (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2 - box.left - 90) };
}
