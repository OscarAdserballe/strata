// CSS zoom scales paint but not layout: divide getBoundingClientRect deltas by zoomOf() before mixing them.

import { PHONE, TABLET } from "../../platform/device.js";

export const ROOM = PHONE ? 1 : TABLET ? 1.2 : 1.4;
export const UI_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4];
const UI_DEFAULT = 1;
// A new storage key: under this ladder an old stored 1.4 would mean 1.4 × 1.4.
export const readUi = (): number => { const v = +(localStorage.getItem("strata.ui2") || 0); return UI_STEPS.includes(v) ? v : UI_DEFAULT; };
export const PZ_STEPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
export const readPz = (): number => { const v = +(localStorage.getItem("strata.pz") || 0); return PZ_STEPS.includes(v) ? v : 1; };

/** The element's painted scale: its zoomed rect width over its unzoomed layout width. */
export interface Measured { offsetWidth: number; getBoundingClientRect(): { width: number } }
export const zoomOf = (el: Measured | null | undefined): number => { if (!el || !el.offsetWidth) return 1; const r = el.getBoundingClientRect().width / el.offsetWidth; return r > 0.05 ? r : 1; };
