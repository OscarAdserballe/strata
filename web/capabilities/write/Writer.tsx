import { Suspense, lazy, useRef } from "react";
import type { WriterProps } from "./editor.tsx";

export type { WriterProps } from "./editor.tsx";

// Tiptap is its own chunk: the dashboard paints without it and fetches it on idle, before the first field opens.
let loading: Promise<typeof import("./editor.tsx")> | null = null;
const load = () => (loading ??= import("./editor.tsx").catch((e) => { loading = null; throw e; }));
export const preloadWriter = (): void => { void load().catch(() => {}); };
const Editor = lazy(load);

/** Every field you write in: rich text kept as Markdown, saved by the caller; `line` is a one-line plain field. */
export function Writer(props: WriterProps) {
  // keys typed before the editor arrives go into a plain field, and the editor takes over with them and the focus
  const typing = useRef(false);
  const plain = <textarea className={"writer-plain " + (props.className ?? "")} aria-label={props.label} placeholder={props.placeholder} value={props.value}
    rows={props.line ? 1 : 3} autoFocus={props.autoFocus} onChange={(e) => props.onChange(props.line ? e.target.value.replace(/\n/g, " ") : e.target.value)}
    onFocus={() => { typing.current = true; props.onFocus?.(); }} onBlur={() => { typing.current = false; props.onBlur?.(); }}
    onKeyDown={(e) => { if (e.key === "Escape") props.onEscape?.(); else if (e.key === "Enter" && props.line) { e.preventDefault(); props.onEnter?.(); } }} />;
  return <Suspense fallback={<div className={"writer" + (props.line ? " line" : "")}>{plain}</div>}><Editor {...props} took={typing} /></Suspense>;
}
