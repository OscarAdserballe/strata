import { useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { primers } from "../../data/entities/primers.ts";
import { toast } from "../../shell/layers.ts";

/** A board's press: asks for a primer for each source lacking one, ten at a time, and says how many went. */
export default function BoardPrimers({ board, onDone }: { board: string; onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const ask = () => {
    setBusy(true);
    primers.requestBoard(board).then(
      (r) => toast(r.queued.length ? `asked for ${r.queued.length} primer${r.queued.length === 1 ? "" : "s"}; the routine writes them` : "every source here has a primer, or one on its way", 4200),
      (e: unknown) => toast(StrataWhy(e, "couldn't ask for primers"), 4200),
    ).finally(() => { setBusy(false); onDone(); });
  };
  return <button disabled={busy} onClick={ask}>Primers for this board</button>;
}
