import { useEffect, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import type { EditorView } from "@tiptap/pm/view";
import { Selection, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { imageRef } from "../../../shared/images/ref.ts";
import { imageSrc, imgProps } from "../../engines/prose/images.tsx";
import { imagesIn, uploadImage } from "../attach/attach.ts";
import { toast } from "../../shell/layers.ts";

export interface WriterProps {
  /** what the field shows when nobody is typing in it: Markdown, or plain text for a `line` */
  value: string;
  /** every edit, as Markdown (plain text for a `line`) */
  onChange(value: string): void;
  className?: string;
  label: string;
  placeholder?: string;
  /** one line of plain text: a title */
  line?: boolean;
  autoFocus?: boolean;
  onEnter?(): void;
  onEscape?(): void;
  onFocus?(): void;
  onBlur?(): void;
}

const OURS = /\/api\/images\/([0-9a-f]{16})$/;

// Stored text keeps the room's image token, ![alt](img:<id>); only the editor sees the URL it is served from.
const RoomImage = Image.extend({
  parseHTML() {
    return [{ tag: "img[src]", getAttrs: (el) => (OURS.test((el as HTMLElement).getAttribute("src") ?? "") ? null : false) }];
  },
  parseMarkdown: (token, h) => {
    const id = /^img:([0-9a-f]{16})$/.exec(token.href ?? "")?.[1];
    return h.createNode("image", { src: id ? imageSrc(id) : token.href, alt: token.text || null });
  },
  renderMarkdown: (node) => {
    const src = String(node.attrs?.src ?? ""), id = OURS.exec(src)?.[1];
    return id ? imageRef(id, String(node.attrs?.alt ?? "")) : `![${node.attrs?.alt ?? ""}](${src})`;
  },
}).configure({ HTMLAttributes: { class: imgProps.className, decoding: "async", referrerpolicy: "no-referrer" } });

// Blank lines between paragraphs aren't kept as &nbsp;: stored notes stay plain Markdown.
const RoomParagraph = Paragraph.extend({
  renderMarkdown: (node, h) => (Array.isArray(node.content) && node.content.length ? h.renderChildren(node.content) : ""),
});

const lineDoc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] });

function extensions(p: WriterProps) {
  const placeholder = Placeholder.configure({ placeholder: p.placeholder ?? "" });
  if (p.line) return [Document.extend({ content: "paragraph" }), Paragraph, Text, UndoRedo, placeholder];
  return [
    StarterKit.configure({ paragraph: false, underline: false, link: { openOnClick: true, autolink: true, HTMLAttributes: { target: "_blank", rel: "noopener" } } }),
    RoomParagraph, RoomImage, Markdown, placeholder,
  ];
}

// the empty paragraph kept under a list or an image for the caret isn't text
const read = (e: Editor, line?: boolean): string => (line ? e.getText().replace(/\n/g, " ") : e.getMarkdown().replace(/\n+$/, ""));

/** An image never splits a line: it takes an empty one (the caret going on below it), or goes under the line it was put in. */
function place(state: EditorState, at: number, node: PMNode) {
  const $at = state.doc.resolve(at), tr = state.tr;
  if (!$at.parent.isTextblock || !$at.depth) return tr.replaceRangeWith(at, at, node);
  if (!$at.parent.content.size) {
    const caret = state.selection.empty && state.selection.$from.parent === $at.parent;
    tr.replaceWith($at.before(), $at.after(), [node, state.schema.nodes.paragraph.create()]);
    if (caret) tr.setSelection(TextSelection.create(tr.doc, $at.before() + node.nodeSize + 1));
    return tr;
  }
  const to = $at.parentOffset ? $at.after() : $at.before();
  return tr.replaceRangeWith(to, to, node);
}

/** Images dropped or pasted upload one by one, each landing where it was put even if typing moved the text since. */
function upload(view: EditorView, files: File[], at: number, held: { at: number }[]): void {
  toast(files.length === 1 ? "Uploading the image…" : `Uploading ${files.length} images…`);
  const spot = { at };
  held.push(spot);
  void (async () => {
    try {
      for (const f of files) {
        const img = await uploadImage(f);
        if (view.isDestroyed) return;
        view.dispatch(place(view.state, Math.min(spot.at, view.state.doc.content.size), view.state.schema.nodes.image.create({ src: imageSrc(img.id), alt: null })));
      }
      toast(files.length === 1 ? "Image added" : "Images added");
    } catch (e) {
      toast(`Couldn’t add that image: ${(e as Error | null)?.message || "try again"}`, 4200);
    } finally {
      held.splice(held.indexOf(spot), 1);
    }
  })();
}

// focus lands where you'd carry on, at the end, never on an image at the top that the first key would replace
function atEnd(e: Editor): void {
  const tr = e.state.tr.setMeta("addToHistory", false);
  if (!tr.doc.lastChild?.isTextblock) tr.insert(tr.doc.content.size, e.state.schema.nodes.paragraph.create());
  e.view.dispatch(tr.setSelection(Selection.findFrom(tr.doc.resolve(tr.doc.content.size), -1, true) ?? Selection.atEnd(tr.doc)));
}

export default function WriterEditor(p: WriterProps) {
  const props = useRef(p);
  props.current = p;
  // `mine` is the editor's own Markdown of `shown`: stored text that only round-trips differently is never saved back
  const shown = useRef(p.value);
  const mine = useRef<string | null>(null);
  const held = useRef<{ at: number }[]>([]);
  const pointed = useRef(false);
  const editor = useEditor({
    extensions: extensions(p),
    ...(p.line ? { content: lineDoc(p.value) } : { content: p.value, contentType: "markdown" as const }),
    autofocus: p.autoFocus ? "end" : false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: p.className ?? "", role: "textbox", "aria-label": p.label, ...(p.line ? {} : { "aria-multiline": "true" }) },
      // the sheet's footer is sticky: keep the caret's line clear of it, not under it
      scrollMargin: { top: 24, bottom: p.line ? 24 : 120, left: 0, right: 0 },
      scrollThreshold: { top: 24, bottom: p.line ? 24 : 120, left: 0, right: 0 },
      handleDOMEvents: { pointerdown: () => { pointed.current = true; return false; } },
      handleKeyDown: (_v, e) => {
        if (e.key === "Escape" && props.current.onEscape) { props.current.onEscape(); return true; }
        if (e.key === "Enter" && props.current.line) { e.preventDefault(); props.current.onEnter?.(); return true; }
        return false;
      },
      handlePaste: (view, e) => {
        if (props.current.line) return false;
        const files = imagesIn(e.clipboardData);
        if (!files.length) return false;
        upload(view, files, view.state.selection.from, held.current);
        return true;
      },
      handleDrop: (view, e, _slice, moved) => {
        if (props.current.line || moved) return false;
        const files = imagesIn(e.dataTransfer);
        if (!files.length) return false;
        e.preventDefault();
        upload(view, files, view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? view.state.selection.from, held.current);
        return true;
      },
    },
    onCreate: ({ editor: e }) => { mine.current = read(e, p.line); atEnd(e); },
    onTransaction: ({ transaction }) => { for (const h of held.current) h.at = transaction.mapping.map(h.at); },
    onUpdate: ({ editor: e }) => {
      const now = read(e, props.current.line);
      if (now === mine.current) return;
      mine.current = now;
      shown.current = now;
      props.current.onChange(now);
    },
    onFocus: ({ editor: e }) => {
      // focus that came from Tab or from Enter in a title carries on at the end; a click keeps its spot
      if (!pointed.current) atEnd(e);
      pointed.current = false;
      props.current.onFocus?.();
    },
    onBlur: () => props.current.onBlur?.(),
  }, []);

  // the caller hands a new value only while the field isn't being typed in: another device's edit, or a reset
  useEffect(() => {
    if (!editor || p.value === shown.current) return;
    shown.current = p.value;
    if (p.line) editor.commands.setContent(lineDoc(p.value), { emitUpdate: false });
    else editor.commands.setContent(p.value, { emitUpdate: false, contentType: "markdown" });
    mine.current = read(editor, p.line);
    atEnd(editor);
  }, [editor, p.value, p.line]);

  return <div className={"writer" + (p.line ? " line" : "")}><EditorContent editor={editor} /></div>;
}
