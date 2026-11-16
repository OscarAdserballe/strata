import { forwardRef, lazy, Suspense } from "react";

export interface WriterProps {
  /** Markdown as the store holds it; plain text for a `line`. */
  value: string;
  /** Called a pause after the last change, on blur and on leaving, through the caller's save path. */
  save(value: string): void;
  label: string;
  placeholder?: string;
  className?: string;
  /** One line of plain text: no marks, and Enter calls `onEnter`. */
  line?: boolean;
  onEnter?(): void;
  onEscape?(): void;
}

export interface WriterHandle {
  /** Sends what is not sent yet. */
  flush(): void;
  focus(): void;
  /** What the field shows now, sent or not. */
  text(): string;
}

let chunk: Promise<typeof import("./editor.tsx")> | null = null;
export const loadWriter = () => (chunk ??= import("./editor.tsx").catch((e) => { chunk = null; throw e; }));
const Lazy = lazy(loadWriter);

/** Fetch the editor while nothing else is happening, so the first click on a field doesn't wait for it. */
export function warmWriter(): () => void {
  const go = () => { void loadWriter().catch(() => {}); };
  if (typeof requestIdleCallback === "function") { const h = requestIdleCallback(go, { timeout: 3000 }); return () => cancelIdleCallback(h); }
  const h = window.setTimeout(go, 600);
  return () => clearTimeout(h);
}

/** The one text field of the dashboard: Markdown in and out, bold, italics, lists and pasted or dropped images. */
export const Writer = forwardRef<WriterHandle, WriterProps>(function Writer(props, ref) {
  const wait = <div className={`writer ${props.line ? "line" : "rich"}`}>
    <div className={`${props.className ?? ""} writer-wait`} aria-label={props.label} aria-busy="true">{props.value || props.placeholder}</div>
  </div>;
  return <Suspense fallback={wait}><Lazy {...props} ref={ref} /></Suspense>;
});
