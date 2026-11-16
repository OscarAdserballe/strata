import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KINDLE_NOTEBOOK, KINDLE_PROMPT } from "./kindle-prompt.ts";

export default function KindleHelp() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => { if (open) { if (!dialog.current?.open) dialog.current?.showModal(); } else { dialog.current?.close(); setCopied(false); } }, [open]);
  async function copy() {
    try { await navigator.clipboard.writeText(KINDLE_PROMPT); setCopied(true); }
    catch {   // no clipboard over plain http: select it for ⌘C instead
      const range = document.createRange(); if (pre.current) range.selectNodeContents(pre.current);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    }
  }
  return <>
    <button type="button" className="home-quiet kindle-help-b" aria-label="Add Kindle highlights" title="Add Kindle highlights" onClick={() => setOpen(true)}>?</button>
    {createPortal(<dialog className="home-tool-dialog kindle-help" ref={dialog} aria-labelledby="kindle-help-title"
      onCancel={() => setOpen(false)} onKeyDown={(e) => e.stopPropagation()}>
      <header><h2 id="kindle-help-title">Add Kindle highlights</h2>
        <button type="button" aria-label="Close" onClick={() => setOpen(false)}>✕</button></header>
      {open ? <div className="home-tool-form">
        <p className="home-tool-note">An agent connected to Strata turns a book's highlights into one page, a heading per chapter, with a card on each highlight.</p>
        <ol className="kindle-steps">
          <li>Open <a href={KINDLE_NOTEBOOK} target="_blank" rel="noopener noreferrer">your Kindle notebook</a>.</li>
          <li>Pick a book, select all its highlights and copy them.</li>
          <li>Paste them into your agent after this prompt.</li>
        </ol>
        <div className="agent-snippet">
          <div><span>The prompt</span><button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
          <pre ref={pre}>{KINDLE_PROMPT}</pre>
        </div>
        <p className="home-tool-note">Pasting the same book again later adds its new highlights and keeps your reviews.</p>
      </div> : null}
    </dialog>, document.body)}
  </>;
}
