import { useEffect, useState } from "react";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import type { CardHistory as History } from "../../../shared/types/index.ts";
import "./card-history.css";

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const TRACE = 9, LISTED = 6;

export default function CardHistory({ card }: { card: { id: string; course: string } }) {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setHistory(null); setError(""); setOpen(false);
    StrataAPI.cardHistory(card.course, card.id).then(h => { if (live) setHistory(h); })
      .catch(e => { if (live) setError(StrataWhy(e, "Couldn't load card history")); });
    return () => { live = false; };
  }, [card.course, card.id, retry]);
  if (error) return <section className="card-history" aria-label="Card history">
    <p role="alert">{error} <button className="ch-retry" onClick={() => setRetry(n => n + 1)}>Retry</button></p>
  </section>;
  if (!history) return <section className="card-history" aria-label="Card history" aria-busy="true" />;
  const { reviews } = history;
  const got = reviews.filter(r => r.got).length;
  // newest first from the server; the trace reads left to right, newest last
  const dots = reviews.slice(0, TRACE).reverse();
  const summary = [reviews.length ? `${reviews.length} review${reviews.length === 1 ? "" : "s"}` : "new", history.keptAt ? `kept ${day(history.keptAt)}` : ""].filter(Boolean).join(" · ");
  return <section className="card-history" aria-label="Card history">
    <button className="ch-trace" aria-expanded={open} onClick={() => setOpen(v => !v)} title="Card history">
      {dots.length ? <span className="ch-dots" aria-hidden="true">
        {dots.map((r, i) => <i key={`${r.at}-${i}`} className={(r.got ? "got" : "missed") + (i === dots.length - 1 ? " last" : "")} />)}
      </span> : null}
      <span>{summary}</span>
      <span className="ch-chev" aria-hidden="true">›</span>
    </button>
    {open ? <div className="ch-sheet">
      <div className="ch-facts">
        {history.addedAt ? <span>Added <b>{day(history.addedAt)}</b></span>
          : history.sourceAddedAt ? <span>Source added <b>{day(history.sourceAddedAt)}</b></span> : null}
        {history.keptAt ? <span>Kept <b>{day(history.keptAt)}</b></span> : null}
        {reviews.length ? <span>Got <b>{got} of {reviews.length}</b></span> : null}
      </div>
      {reviews.length ? <ol>
        {reviews.slice(0, LISTED).map((r, i) => <li key={`${r.at}-${i}`}>
          <time dateTime={new Date(r.at).toISOString()}>{day(r.at)}</time>
          <span className={r.got ? "recalled" : "missed"}>{r.got ? "Got it" : "Missed"}</span>
        </li>)}
      </ol> : <p>No reviews yet.</p>}
      {reviews.length > LISTED ? <p className="ch-more">+{reviews.length - LISTED} earlier</p> : null}
    </div> : null}
  </section>;
}
