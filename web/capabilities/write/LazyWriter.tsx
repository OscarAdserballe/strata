import { lazy, Suspense } from "react";
import type { WriterProps } from "./Writer.tsx";

// Tiptap is most of the dashboard's weight: its own chunk, fetched on idle after boot, so the inbox never waits for it.
let chunk: Promise<typeof import("./Writer.tsx")> | null = null;
const load = () => (chunk ??= import("./Writer.tsx").catch((e) => { chunk = null; throw e; }));
const Rich = lazy(load);

export function prefetchWriter(): void {
  const go = () => { void load().catch(() => {}); };
  if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 3000 }); else setTimeout(go, 1200);
}

/** Puts the caret at the end of the Writer inside `box`, as Enter in a title does. */
export function focusWriterIn(box: Element | null): void {
  const el = box?.querySelector<HTMLElement & { editor?: { commands: { focus(at: "end"): boolean } } }>(".ProseMirror");
  if (el?.editor) el.editor.commands.focus("end"); else el?.focus();
}

export default function Writer(p: WriterProps) {
  return <Suspense fallback={<div className={`writer md ${p.className ?? ""}`} aria-busy="true">{p.value}</div>}><Rich {...p} /></Suspense>;
}
