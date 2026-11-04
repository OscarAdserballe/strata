import { useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import "./card-deleted.css";

export default function CardDeleted({ onRestore }: { onRestore: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const put = () => {
    setBusy(true); setError("");
    onRestore().catch((e) => setError(StrataWhy(e, "couldn't put that card back"))).finally(() => setBusy(false));
  };
  return (
    <div className="card-deleted" role="status" onClick={(e) => e.stopPropagation()}>
      <span>{error || "Card deleted."}</span>
      <button type="button" disabled={busy} onClick={put}>
        {busy ? "putting it back…" : "put it back"}</button>
    </div>
  );
}
