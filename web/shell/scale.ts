import { useEffect, useState } from "react";
import { StrataAPI } from "../data/api.ts";
import { UI_STEPS, readUi } from "../engines/zoom/zoom.ts";
import { bindGesturePinch } from "../engines/zoom/pinch.ts";
import { TOUCH } from "../platform/device.js";
import { toast } from "./layers.ts";

export function useRoomScale(board: () => string | null, card: { current: HTMLElement | null }, rebind: unknown): [number, (d: number) => void] {
  const [ui, setUi] = useState(readUi);
  function stepUi(d: number) {
    setUi((v) => {
      const next = UI_STEPS[Math.max(0, Math.min(UI_STEPS.length - 1, UI_STEPS.indexOf(v) + d))];
      try { localStorage.setItem("strata.ui2", String(next)); } catch (e) {}
      toast("scale " + Math.round(next * 100) + "%");
      if (next !== v) StrataAPI.log("ui_scale", { board: board(), ui: next, dir: d });
      return next;
    });
  }
  useEffect(() => (TOUCH ? bindGesturePinch(card.current, stepUi) : undefined), [rebind]);
  return [ui, stepUi];
}
