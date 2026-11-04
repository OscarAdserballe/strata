import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ROOM, readUi, zoomOf } from "../../engines/zoom/zoom.ts";

// a layout width: divide by the room zoom as well as the ui step; on narrow screens the floors give way
export const clampSplit = (w: number, z: number): number => {
  const avail = window.innerWidth / z - 12;          // less the divider's own strip
  if (avail >= 380 + 460) return Math.max(380, Math.min(avail - 460, w));
  const lo = Math.round(avail * 0.34), hi = Math.round(avail * 0.66);
  const want = w > 0 ? w : avail * 380 / (380 + 460);
  return Math.round(Math.max(lo, Math.min(hi, want)));
};

// own key: design prototypes on this origin use strata.splitW
const SPLIT_KEY = "strata.split";

export function initialSplit(): number {
  const z = readUi() * ROOM;
  const v = +(localStorage.getItem(SPLIT_KEY) || 0);
  return Math.round(clampSplit(v >= 380 ? v : window.innerWidth * 0.4 / z, z));
}

export function useSplit(ui: number) {
  const [splitW, setSplitW] = useState(initialSplit);
  const splitRef = useRef(splitW);
  splitRef.current = splitW;

  // re-clamp on resize (iPad rotation) without saving; the stored width stays the user's choice
  useEffect(() => {
    const onR = () => setSplitW(Math.round(clampSplit(splitRef.current, ui * ROOM)));
    onR();                                   // the room's own zoom just changed too
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, [ui]);

  // the pointer moves in painted px, the width is layout px
  function startSplit(e: ReactPointerEvent<HTMLElement>) {
    e.preventDefault();
    const sx = e.clientX, sw = splitRef.current; let latest = sw;
    const z = zoomOf(e.currentTarget.parentNode as HTMLElement | null) || 1;
    const mv = (ev: PointerEvent) => { latest = clampSplit(sw + (ev.clientX - sx) / z, z); setSplitW(latest); };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      try { localStorage.setItem(SPLIT_KEY, String(Math.round(latest))); } catch { /* private mode */ }
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }

  return { splitW, startSplit };
}
