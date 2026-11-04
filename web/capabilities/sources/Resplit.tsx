import { useEffect, useRef, useState } from "react";
import { prefetch } from "../../data/api.ts";
import { useEntry, useQuery } from "../../data/store.ts";
import { sources, splitKey, splitPath, splitRead, type Resplit, type SplitChoice, type SplitPlan } from "../../data/entities/sources.ts";
import { importPlanNow, loadImportPlan } from "./import-plan-load.ts";

/** Started on pointerdown, so the editor waits on one round trip at most. */
export function warmResplit(board: string, rid: string): void {
  void prefetch(splitPath(board, rid));
  void loadImportPlan().catch(() => {});
}

export interface ResplitProps {
  board: string;
  rid: string;
  onClose(): void;
  onDone(result: Resplit): void;
  onError(error: unknown, said: string): void;
}

/** The import's section editor, opened on a source's current split; confirming re-sections it and re-distils. */
export default function ResplitDialog({ board, rid, onClose, onDone, onError }: ResplitProps) {
  const choice = useQuery<SplitChoice>(splitKey(rid), splitRead(board, rid));
  const entry = useEntry<SplitChoice>(splitKey(rid));
  const [Plan, setPlan] = useState(importPlanNow);
  const [saving, setSaving] = useState(false);
  const latest = useRef({ onClose, onError });
  latest.current = { onClose, onError };
  useEffect(() => {
    if (Plan) return;
    loadImportPlan().then((m) => setPlan(() => m), (e) => { latest.current.onError(e, "couldn't open the sections"); latest.current.onClose(); });
  }, [Plan]);
  const failed = entry?.error;
  useEffect(() => {
    if (failed) { latest.current.onError(failed, "couldn't read the sections"); latest.current.onClose(); }
  }, [failed]);
  // a split held from before the last write is stale, and its rev would be refused
  if (!choice || entry?.stale || !Plan) return null;
  const confirm = (plan: unknown) => {
    setSaving(true);
    sources.resplit(board, rid, plan as SplitPlan, choice.rev)
      .then(onDone, (e) => onError(e, "couldn't change those sections"))
      .finally(() => setSaving(false));
  };
  return <Plan.default source={choice} plan={choice.plan} saving={saving} onClose={onClose} onConfirm={confirm}
    hint="The sections as they are. Split, join or untick, then re-distil." confirmLabel="Re-distil" />;
}
