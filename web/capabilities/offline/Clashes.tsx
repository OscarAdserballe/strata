import { useState, useSyncExternalStore } from "react";
import { conflicts, type Clash } from "../../data/conflicts.ts";
import { marks } from "../../data/entities/marks.ts";
import { subscribePending, pending } from "../../data/mutate.ts";

// Offline writes that came back refused: each is shown with both sides and settled by hand.

const markWaits = () => pending().filter((p) => p.lanes.some((l) => l.startsWith("mark:"))).length;
export const useMarksWaiting = (): number => useSyncExternalStore(subscribePending, markWaits);
export const useClashes = (): readonly Clash[] => useSyncExternalStore(conflicts.subscribe, conflicts.getSnapshot);

function Row({ c }: { c: Clash }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keep = async (note: string | null) => {
    setBusy(true); setError("");
    try { await marks.keep(c.board, c.mid, note); conflicts.settle(c.id); }
    catch (e) { setError(e instanceof Error ? e.message : "not saved"); }
    finally { setBusy(false); }
  };
  const both = [c.theirs, c.mine].filter(Boolean).join("\n\n");
  return <li className="clash" data-clash={c.id}>
    <p className="clash-quote">“{c.quote.slice(0, 160)}”</p>
    <p className="clash-why">Not saved: {c.why}.</p>
    <div className="clash-sides">
      <div><b>Yours, offline</b><p>{c.mine || <i>a highlight</i>}</p></div>
      {c.canKeep ? <div><b>There now</b><p>{c.theirs || <i>no note</i>}</p></div> : null}
    </div>
    <div className="clash-acts">
      {c.canKeep ? <>
        <button disabled={busy} onClick={() => keep(c.mine)}>Keep yours</button>
        <button disabled={busy} onClick={() => keep(both || null)}>Keep both</button>
        <button disabled={busy} onClick={() => conflicts.settle(c.id)}>Keep theirs</button>
      </> : <button disabled={busy} onClick={() => conflicts.settle(c.id)}>OK</button>}
      {error ? <span className="clash-error">{error}</span> : null}
    </div>
  </li>;
}

export function ClashList({ onClose }: { onClose: () => void }) {
  const list = useClashes();
  return <div className="clashes" role="dialog" aria-label="Changes that clashed">
    <header><b>{list.length ? `${list.length} offline change${list.length === 1 ? "" : "s"} didn’t fit` : "All settled"}</b><button onClick={onClose}>Close</button></header>
    <ul>{list.map((c) => <Row key={c.id} c={c} />)}</ul>
  </div>;
}
