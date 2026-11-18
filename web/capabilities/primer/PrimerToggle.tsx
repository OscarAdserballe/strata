import { useSyncExternalStore } from "react";
import { prefetch } from "../../data/api.ts";
import { useEntity } from "../../data/store.ts";
import { primerKey, primerPath, type PrimerEntity } from "../../data/entities/primers.ts";
import { primerPanel } from "./panel.ts";

/** The reader bar's Primer chip: opens the source's overview over its pages, and says whether one is waiting there. */
export default function PrimerToggle({ board, rid }: { board: string; rid: string }) {
  const open = useSyncExternalStore(primerPanel.subscribe, primerPanel.get);
  const status = useEntity<PrimerEntity, string | undefined>(primerKey(rid), (v) => v?.status);
  const warm = () => { void prefetch(primerPath(board, rid)); };
  return (
    <button type="button" className={"rbar-chip rbar-primer" + (open ? "" : " off") + (status ? ` ${status}` : "")} aria-pressed={open}
      title={open ? "back to the source" : "the primer: an overview to read before page 1"}
      onPointerEnter={warm} onPointerDown={warm} onClick={() => primerPanel.set(!open)}>
      <i />primer
    </button>
  );
}
