import { useSyncExternalStore } from "react";
import { discard, pending, retry, subscribePending } from "../data/mutate.ts";
import { saveWatch } from "./saving.ts";
import "./save-chip.css";

// Floats over every veil so a failed write's Retry/Discard is reachable from any screen.
const saves = saveWatch({ pending, subscribePending });
const failed = () => pending().filter((op) => op.state === "failed");

export default function SaveChip() {
  const line = useSyncExternalStore(saves.watch, saves.read, () => "");
  if (!line) return null;
  if (line === "saving") return <div className="save-chip" role="status">saving…</div>;
  return <div className="save-chip failed" role="alert">not saved ({line}) —
    <button onClick={() => { for (const op of failed()) retry(op.id); }}>Retry</button>
    <button onClick={() => { for (const op of failed()) discard(op.id); }}>Discard</button></div>;
}
