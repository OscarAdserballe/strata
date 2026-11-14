// Messages across the sandbox wall. Offsets index the page's own text, walked the same way on both sides.

import type { LayerItem } from "../fold/layers.ts";

/** A mark on a page's words; one on a labelled box (data-strata-id) names it in `box`. */
export interface LiveMark { id: string; start: number; end: number; quote: string; note: boolean; box?: string | null }
export interface Box { left: number; top: number; width: number; height: number }
export type LayerIntent = "edit" | "leave" | "remove" | "reply" | "show" | "later" | "grade" | "keep" | "discard" | "ask" | "capture";

export type ToPage =
  | { t: "marks"; marks: LiveMark[]; open: string | null }
  | { t: "layers"; items: LayerItem[]; scale: number; fresh?: boolean }
  | { t: "reveal"; n: number; quote: string | null; slug: string | null; box?: string | null }
  | { t: "clear" }
  | { t: "state"; n: number; value: string | null; why?: string }
  | { t: "saved"; n: number; ok: boolean; why?: string };

export type FromPage =
  | { t: "ready"; words: number }
  | { t: "sel"; start: number; end: number; quote: string; box: Box; at?: string | null; own?: string | null }
  | { t: "unsel" }
  | { t: "mark"; id: string }
  | { t: "layer"; intent: LayerIntent; id: string; text?: string; back?: string; got?: boolean }
  | { t: "revealed"; n: number; found: boolean }
  | { t: "press" }
  | { t: "load"; n: number }
  | { t: "save"; n: number; value: string }
  | { t: "height"; h: number };

export const STRATA = "strata-live";
