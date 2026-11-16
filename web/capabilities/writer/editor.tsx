import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { imageSrc } from "../../engines/prose/images.tsx";
import { imagesIn, uploadImage } from "../attach/attach.ts";
import { extensionsFor, lineDoc } from "./schema.ts";
import type { WriterHandle, WriterProps } from "./Writer.tsx";

const read = (e: Editor, line: boolean): string => (line ? e.getText() : e.getMarkdown());

/** The Tiptap side of the Writer, loaded on first use. */
const WriterEditor = forwardRef<WriterHandle, WriterProps>(function WriterEditor(props, ref) {
  const { value, line = false, label, placeholder = "", className = "" } = props;
  const latest = useRef(props);
  latest.current = props;
  // what the field shows as its own, and what it has not sent yet
  const mine = useRef(value);
  const pending = useRef<string | null>(null);
  const timer = useRef(0);
  const [focused, setFocused] = useState(false);
  const [say, setSay] = useState("");
  const flush = () => { clearTimeout(timer.current); if (pending.current !== null) { const v = pending.current; pending.current = null; latest.current.save(v); } };

  const put = (editor: Editor, files: File[], at: number) => {
    setSay(files.length === 1 ? "Uploading the image…" : `Uploading ${files.length} images…`);
    void (async () => {
      for (const f of files) {
        try {
          const img = await uploadImage(f);
          if (editor.isDestroyed) return;
          const pos = Math.min(at, editor.state.doc.content.size);
          editor.chain().insertContentAt(pos, { type: "image", attrs: { src: `img:${img.id}`, alt: "" } }).run();
          at = pos + 1;
        } catch (e) {
          setSay(`Couldn’t add that image: ${(e as Error | null)?.message || "try again"}`);
          return;
        }
      }
      setSay("");
    })();
  };

  const editor = useEditor({
    extensions: extensionsFor(line, placeholder, imageSrc),
    content: line ? lineDoc(value) : value,
    contentType: line ? "json" : "markdown",
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: `${className}${line ? "" : " md"}`, role: "textbox", "aria-label": label, "aria-multiline": String(!line) },
      // the sticky footer under a doc covers the bottom of the sheet
      scrollMargin: { top: 8, left: 8, right: 8, bottom: line ? 8 : 112 },
      transformPastedText: (text) => (line ? text.replace(/\s*\n\s*/g, " ") : text),
      handleKeyDown: (_view, e) => {
        const p = latest.current;
        if (e.key === "Escape" && p.onEscape) { flush(); p.onEscape(); return true; }
        if (e.key === "Enter" && line && !e.isComposing) { e.preventDefault(); p.onEnter?.(); return true; }
        return false;
      },
      handlePaste: (view, e) => {
        const files = line ? [] : imagesIn(e.clipboardData);
        if (!files.length || !editor) return false;
        put(editor, files, view.state.selection.from);
        return true;
      },
      handleDrop: (view, e, _slice, moved) => {
        const files = line || moved ? [] : imagesIn(e.dataTransfer);
        if (!files.length || !editor) return false;
        // the drop is the field's: not the room's, which would make a source of it
        e.preventDefault(); e.stopPropagation();
        put(editor, files, view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? view.state.selection.from);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const v = read(e, line);
      mine.current = v;
      pending.current = v;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 700);
    },
    onFocus: () => setFocused(true),
    onBlur: () => { flush(); setFocused(false); },
  });

  // out of the field and caught up: take the server's text, which may hold another device's edit
  useEffect(() => {
    if (!editor || focused || pending.current !== null || value === mine.current) return;
    mine.current = value;
    editor.commands.setContent(line ? lineDoc(value) : value, { emitUpdate: false, contentType: line ? "json" : "markdown" });
  }, [editor, value, focused]);
  useEffect(() => () => flush(), []);

  useImperativeHandle(ref, () => ({
    flush,
    focus: () => { editor?.commands.focus("end"); },
    text: () => mine.current,
  }), [editor]);

  return <div className={`writer ${line ? "line" : "rich"}`}>
    <EditorContent editor={editor} />
    {say ? <p className="writer-say" role="status">{say}</p> : null}
  </div>;
});

export default WriterEditor;
