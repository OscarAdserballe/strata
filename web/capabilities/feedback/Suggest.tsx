import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { StrataWhy } from "../../data/api.ts";
import { feedback } from "../../data/entities/feedback.ts";

export default function Suggest() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useId();
  useEffect(() => {
    if (!open) return;
    const el = dialog.current!;
    el.showModal();
    el.querySelector("textarea")!.focus();
    return () => { el.close(); trigger.current?.focus(); };
  }, [open]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      await feedback.send({ kind: "general", comment: text.trim() });
      setText("");
      setSent(true);
    } catch (e) {
      setError(StrataWhy(e, "Couldn’t send your suggestion. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button ref={trigger} className="suggest-button" aria-haspopup="dialog" onClick={() => { setSent(false); setError(""); setOpen(true); }}>Suggest improvement</button>
    {open ? createPortal(
      <dialog className="suggest-dialog" ref={dialog} aria-labelledby={heading} onKeyDown={(e) => e.stopPropagation()}
        onCancel={(e) => { if (busy) e.preventDefault(); else setOpen(false); }}>
        <form onSubmit={send}>
          <h2 id={heading}>Suggest improvement</h2>
          {sent ? <p role="status">Thanks — your suggestion has been saved.</p> : <>
            <p>What would make Strata better for you?</p>
            <textarea aria-label="Your suggestion" placeholder="An idea, something confusing, or anything you wish worked better…"
              rows={5} maxLength={4000} required disabled={busy} value={text} onChange={(e) => setText(e.target.value)} />
            {error ? <p className="suggest-error" role="alert">{error}</p> : null}
          </>}
          <div className="suggest-actions">
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>{sent ? "Done" : "Cancel"}</button>
            {!sent ? <button type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send suggestion"}</button> : null}
          </div>
        </form>
      </dialog>, document.body
    ) : null}
  </>;
}
