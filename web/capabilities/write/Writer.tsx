import { useEffect, useRef, useState } from "react";
import type { WriterProps } from "./editor.tsx";

export type { WriterProps } from "./editor.tsx";

// Tiptap is its own chunk: the dashboard paints without it and fetches it on idle, before the first field opens.
type Editor = (typeof import("./editor.tsx"))["default"];
let ready: Editor | null = null;
let loading: Promise<Editor> | null = null;
const load = () => (loading ??= import("./editor.tsx").then((m) => (ready = m.default), (e) => { loading = null; throw e; }));
export const preloadWriter = (): void => { void load().catch(() => {}); };

/** Every field you write in: rich text kept as Markdown, saved by the caller; `line` is a one-line plain field. */
export function Writer(props: WriterProps) {
  const [Ed, setEd] = useState<Editor | null>(() => ready);
  // until the editor arrives a plain field takes the keys; it hands over only once you leave it, so no key lands in between
  const typing = useRef(false);
  useEffect(() => {
    if (Ed) return;
    let live = true;
    load().then((e) => { if (live && !typing.current) setEd(() => e); }, () => {});
    return () => { live = false; };
  }, [Ed]);
  if (Ed) return <Ed {...props} />;
  return <div className={"writer" + (props.line ? " line" : "")}>
    <textarea className={"writer-plain " + (props.className ?? "")} aria-label={props.label} placeholder={props.placeholder} value={props.value}
      rows={props.line ? 1 : 3} autoFocus={props.autoFocus} onChange={(e) => props.onChange(props.line ? e.target.value.replace(/\n/g, " ") : e.target.value)}
      onFocus={() => { typing.current = true; props.onFocus?.(); }}
      onBlur={() => { typing.current = false; props.onBlur?.(); if (ready) setEd(() => ready); }}
      onKeyDown={(e) => { if (e.key === "Escape") props.onEscape?.(); else if (e.key === "Enter" && props.line) { e.preventDefault(); props.onEnter?.(); } }} />
  </div>;
}
