import { useEffect, useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { primers } from "../../data/entities/primers.ts";
import { PRIMER_BOARD_BATCH } from "../../../shared/reading/primer.ts";

/** The board menu's item: asks for a primer of each source without one, ten at a time, and says how it went. */
export default function BoardPrimers({ board }: { board: string }) {
  const [said, setSaid] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { setSaid(null); }, [board]);
  const ask = () => {
    setBusy(true);
    primers.board(board).then((r) => {
      setBusy(false);
      setSaid(!r.asked ? "every source has one" : `asked for ${r.asked}${r.left ? ` · ${r.left} more next time` : ""}`);
    }, (e) => { setBusy(false); setSaid(StrataWhy(e, "they weren't asked for")); });
  };
  return <button type="button" disabled={busy} title={`a primer for each source without one, ${PRIMER_BOARD_BATCH} at a time`} onClick={ask}>
    {busy ? "Asking…" : "Primers for this board"}{said ? <small className="pp-msaid"> · {said}</small> : null}</button>;
}
