// The Writer: the dashboard's one editor (bold, italics, lists, pasted images), stored as Markdown; the editor is a lazy chunk.
import "./write.css";
import { useEffect, useRef, useState } from "react";
import { imageSrc } from "../../engines/prose/images.tsx";
import { dragsImages, imagesIn, uploadImage } from "../attach/attach.ts";
import type { Writing } from "./editor.ts";

export interface WriterProps {
  value: string;
  onChange(markdown: string): void;
  label: string;
  onFocus?(): void;
  onBlur?(): void;
  onKeyDown?(e: KeyboardEvent): void;
  placeholder?: string;
  className?: string;
  id?: string;
}

let chunk: Promise<typeof import("./editor.ts")> | null = null;
/** Fetch the editor ahead of the first field, on idle or a pointerdown that will open one. */
export const loadWriter = () => (chunk ??= import("./editor.ts").catch((e) => { chunk = null; throw e; }));

const images = { of: imagesIn, drags: dragsImages, upload: uploadImage, src: imageSrc };

export default function Writer(props: WriterProps) {
  const { value, placeholder = "", className = "", label, id } = props;
  const host = useRef<HTMLDivElement | null>(null);
  const writing = useRef<Writing | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "plain">("loading");
  const [status, setStatus] = useState("");
  // the editor is made once, so it calls whatever handlers the latest render passed
  const p = useRef(props);
  p.current = props;

  useEffect(() => {
    let gone = false;
    loadWriter().then((m) => {
      if (gone || !host.current) return;
      writing.current = m.mount(host.current, {
        value: p.current.value, label, placeholder, className, id, images, say: setStatus,
        onChange: (md) => p.current.onChange(md), onFocus: () => p.current.onFocus?.(), onBlur: () => p.current.onBlur?.(), onKeyDown: (e) => p.current.onKeyDown?.(e),
      });
      setState("ready");
    }, () => { if (!gone) setState("plain"); });
    return () => { gone = true; writing.current?.destroy(); writing.current = null; };
  }, []);
  useEffect(() => { writing.current?.take(value); }, [value]);

  // offline with the chunk not yet cached: a plain field still takes what you write
  if (state === "plain") return <textarea className={`wr ${className}`.trim()} aria-label={label} id={id} value={value} placeholder={placeholder} rows={6}
    onChange={(e) => props.onChange(e.target.value)} onFocus={props.onFocus} onBlur={props.onBlur} />;
  return <>
    {state === "loading" ? <div className={`wr md wr-still ${className}`.trim()} role="textbox" aria-label={label} aria-busy="true"
      data-placeholder={placeholder} data-empty={String(!value)}>{value}</div> : null}
    <div ref={host} className="wr-box" />
    {status ? <span className="wr-status" role="status">{status}</span> : null}
  </>;
}
