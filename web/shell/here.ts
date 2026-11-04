import { useEffect, useRef } from "react";
import type { Route } from "../surfaces.ts";
// Screens provide `here` as a function rather than state, so scroll-driven changes never re-render the room.

export interface HereCard {
  id: string;
  deck: string;
  /** `subject` in a review or cram; `scenery` when the deck merely sits beside the page in the reader. */
  role: "subject" | "scenery";
  course?: string;
  prompt?: string;
  shownMs?: number | null;
  rung?: number | null;
  picked?: number | null;
  /** Before it's revealed, asking about the card is fishing for the answer. */
  revealed?: boolean;
}

export interface Here {
  surface: Route;
  board?: string | null;
  source?: string | null;
  section?: string | null;
  page?: number | null;
  card?: HereCard | null;
  selection?: string | null;
}

type Provider = () => Here;
const stack: { id: number; read: Provider }[] = [];
let seq = 0;

export function here(): Here {
  const top = stack[stack.length - 1];
  return top ? top.read() : { surface: "library" };
}

export function provideHere(read: Provider): () => void {
  const id = ++seq;
  stack.push({ id, read });
  return () => {
    const at = stack.findIndex((p) => p.id === id);
    if (at >= 0) stack.splice(at, 1);
  };
}

export function useProvideHere(read: Provider): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => provideHere(() => latest.current()), []);
}

export interface WireHere {
  surface: Route;
  sectionId: string | null;
  page: number | null;
  card: { prompt?: string; revealed?: boolean; shownMs?: number | null; role: "subject" | "scenery" } | null;
  onHome: boolean;
  onBoard: boolean;
  thread?: string | null;
}
export function wireHere(h: Here): WireHere {
  const c = h.card;
  return {
    surface: h.surface,
    sectionId: h.section ?? null,
    page: h.page ?? null,
    card: c && c.prompt ? { prompt: c.prompt, revealed: !!c.revealed, shownMs: c.shownMs ?? null, role: c.role } : null,
    // Older servers still read `onHome` instead of `surface`.
    onHome: h.surface === "board",
    onBoard: !!h.board,
  };
}
