// pdf.js's endOfContent behaviour (from its viewer bundle), using clientY so both values share one space.

export type BoundTextLayer = HTMLElement & { release?: () => void };

export function bindEndOfContent(layer: BoundTextLayer): void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.appendChild(end);
  const arm = (clientY: number, target: EventTarget | null) => {
    // Start the block where the drag began so dragging upward doesn't select everything above.
    if (target !== layer) {
      const box = layer.getBoundingClientRect();
      const r = box.height ? Math.max(0, Math.min(1, (clientY - box.top) / box.height)) : 0;
      end.style.top = (r * 100).toFixed(2) + "%";
    }
    end.classList.add("active");
  };
  layer.addEventListener("mousedown", (e) => arm(e.clientY, e.target));
  // Safari sends no mousedown for a long-press selection, so arm on touchstart too.
  layer.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (t) arm(t.clientY, e.target); }, { passive: true });
  // Release on the document, since drags end anywhere; `release` removes it when the page is undrawn.
  const done = () => { end.style.top = ""; end.classList.remove("active"); };
  layer.addEventListener("mouseup", done);
  document.addEventListener("mouseup", done);
  document.addEventListener("touchend", done);
  layer.release = () => { document.removeEventListener("mouseup", done); document.removeEventListener("touchend", done); };
}

// Fit to the canvas content box (it has a 1px border); unzoomed layout values need no scaling.
export const fitLayer = (slide: ParentNode): boolean => {
  const layer = slide.querySelector<HTMLElement>(".tlayer");
  const cv = slide.querySelector("canvas");
  if (!layer || !cv || !layer.dataset.pw) return true;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return false;
  layer.style.left = (cv.offsetLeft + cv.clientLeft) + "px";
  layer.style.top = (cv.offsetTop + cv.clientTop) + "px";
  layer.style.width = w + "px";
  layer.style.height = h + "px";
  // CSS px per PDF point, at the size this page is actually being displayed
  layer.style.setProperty("--scale-factor", String(w / +layer.dataset.pw));
  return true;
};
