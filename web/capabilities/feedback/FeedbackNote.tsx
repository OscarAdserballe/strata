import { useEffect, useRef, useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { feedback } from "../../data/entities/feedback.ts";

export interface FeedbackNoteProps {
  payload: Record<string, unknown>;
}

function FeedbackNote({ payload }: FeedbackNoteProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const typed = useRef("");              // what the box holds now, for a failure that arrives late
  typed.current = text;
  useEffect(() => {
    if (!open || !boxRef.current) return;
    boxRef.current.focus();
    // the form drops downward; in a scroller it would otherwise open below the fold
    try { boxRef.current.scrollIntoView({ block: "nearest" }); } catch { /* old glass */ }
  }, [open]);
  const save = () => {
    const comment = text.trim();
    setText(""); setOpen(false); setErr("");
    if (!comment) return;
    // a late failure must not overwrite a newer note already typed in the box
    feedback.send({ ...payload, comment })
      .then(() => { setSent(true); setTimeout(() => setSent(false), 1600); })
      .catch((e) => {
        const why = StrataWhy(e, "that note wasn't saved");
        if (typed.current.trim()) setErr(`${why} — it said: “${comment}”`);
        else { setText(comment); setErr(why); }
        setOpen(true);
      });
  };
  const close = () => { setText(""); setOpen(false); setErr(""); };
  if (sent) return <span className="fb"><span className="fb-done">noted ✓</span></span>;
  return (
    <span className="fb">
      <button className="fb-b" title="something off here? leave a note"
        onClick={() => { if (open) setOpen(false); else { setErr(""); setOpen(true); } }}>✎</button>
      {open ? (
        <span className="fb-pop">
          <textarea ref={boxRef} value={text} rows={2} placeholder="what's off here?"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
              if (e.key === "Escape") { setOpen(false); setErr(""); }
            }} />
          {err ? <span className="fb-err" role="alert">{err}</span> : null}
          <span className="fb-row">
            <button className="fb-x" onClick={close}>cancel</button>
            <button className="fb-go" onClick={save}>save</button>
          </span>
        </span>
      ) : null}
    </span>
  );
}

export default FeedbackNote;
