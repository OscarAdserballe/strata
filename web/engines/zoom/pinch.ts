// Trackpad pinch arrives as ctrl+wheel; pool deltas into steps and preventDefault so the tab doesn't zoom.
export function bindWheelPinch(el: HTMLElement | null, step: (d: number) => void): () => void {
  if (!el) return () => {};
  let acc = 0;
  const T = 24;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;                       // an ordinary scroll, not a pinch
    e.preventDefault();
    acc += -e.deltaY;
    while (acc >= T) { step(1); acc -= T; }
    while (acc <= -T) { step(-1); acc += T; }
  };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
}

// WebKit fires gesture events instead of ctrl-wheel for touch pinch; preventDefault stops page zoom.
export function bindGesturePinch(el: HTMLElement | null, step: (d: number) => void): () => void {
  if (!el) return () => {};
  let applied = 0;
  const start = (e: Event) => { e.preventDefault(); applied = 0; };
  const change = (e: Event) => {
    e.preventDefault();
    const want = Math.round(Math.log((e as Event & { scale?: number }).scale || 1) / Math.log(1.22));
    while (applied < want) { step(1); applied++; }
    while (applied > want) { step(-1); applied--; }
  };
  el.addEventListener("gesturestart", start);
  el.addEventListener("gesturechange", change);
  return () => { el.removeEventListener("gesturestart", start); el.removeEventListener("gesturechange", change); };
}
