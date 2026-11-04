import type { MutableRefObject } from "react";
import { useProvideHere } from "../../shell/here.ts";
import { cardPrompt } from "../../capabilities/card/drill-order.ts";
import type { ResourceMeta, Section } from "../../../shared/types/index.ts";
import type { DrillCard, HeldPair } from "./useDrill.ts";

export interface ReaderHereView {
  activeId: string | null;
  onHome: boolean;
  pair: HeldPair;
  src: ResourceMeta | null;
  openSection: Section | null;
  card: DrillCard | null;
  done: boolean;
}

export function useReaderHere(st: ReaderHereView, at: { atSection: Section | null; atPage: number }, shownAt: MutableRefObject<number>): void {
  useProvideHere(() => {
    const sec = (!st.onHome && (at.atSection || st.openSection)) || null, c = st.card, t = shownAt.current;
    return {
      surface: st.onHome ? "board" : "reader",
      board: st.activeId, source: (!st.onHome && st.pair.resourceId) || null,
      section: sec ? sec.id : null,
      page: (st.src && st.src.kind === "pdf" && at.atPage) || null,
      card: c ? { id: c.id, deck: String(c.deck || ""), role: "scenery", prompt: cardPrompt(c) as string | undefined, revealed: !!st.done, shownMs: t ? Date.now() - t : null } : null,
    };
  });
}
