// The notepad: a pop-open Writer for stray frictions on every screen of the room and the dashboard.
import "./pad.css";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { mergePad, PAD_KEY, pad, usePad } from "../../data/entities/pad.ts";
import { store } from "../../data/store.ts";
import { toast } from "../../shell/layers.ts";
import Writer, { loadWriter } from "../write/Writer.tsx";
import { PAD_KEY_LABEL, closePad, isPadKey, togglePad, usePadOpen } from "./pad.ts";
import { zoomOf } from "../../engines/zoom/zoom.ts";
import { type Edges, type Rect, clampRect, cornerRect, loadRect, resize, saveRect } from "./rect.ts";

const GRIPS: Edges[] = ["w", "e", "s", "nw", "ne", "sw", "se"];

// One listener however many pads are mounted.
let keys = 0;
const onKey = (e: KeyboardEvent): void => { if (isPadKey(e)) { e.preventDefault(); e.stopPropagation(); togglePad(); } };

export default function Pad() {
  const open = usePadOpen();
  useEffect(() => {
    if (!keys++) document.addEventListener("keydown", onKey, true);
    return () => { if (!--keys) document.removeEventListener("keydown", onKey, true); };
  }, []);
  return open ? <Sheet /> : (
    <button className="pad-chip" aria-expanded={false} aria-controls="strata-pad" title={`Notepad (${PAD_KEY_LABEL})`}
      onPointerDown={() => void loadWriter().catch(() => {})} onClick={togglePad}>Notepad<span aria-hidden="true"> · {PAD_KEY_LABEL}</span></button>
  );
}

function Sheet() {
  const held = usePad();
  const [text, set, flush, focus, gen] = usePadText(held?.text ?? "");
  const box = useRef<HTMLElement | null>(null);
  // another tab may have written since this one last looked
  useEffect(() => { void store.refetch(PAD_KEY); }, []);
  // opened by key or chip: the caret goes to the end, ready to write
  useEffect(() => {
    if (!held) return;
    let tries = 0, h = 0;
    const put = () => {
      const ed = box.current?.querySelector<HTMLElement>(".ProseMirror");
      if (!ed) { if (++tries < 40) h = window.setTimeout(put, 50); return; }
      ed.focus();
      const sel = getSelection(), r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false); sel?.removeAllRanges(); sel?.addRange(r);
    };
    put();
    return () => clearTimeout(h);
  }, [!!held, gen]);
  useEffect(() => () => flush(), []);
  const [grab, home] = usePlacement(box);
  return (
    <section ref={box} id="strata-pad" className="pad-sheet" aria-label="Notepad"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); flush(); closePad(); } }}>
      <header onPointerDown={grab("move")} onDoubleClick={home} title="Drag to move · double-click to send it back to the corner">
        <b>Notepad</b><span>{PAD_KEY_LABEL}</span>
        <button className="pad-x" aria-label="Close the notepad" onClick={() => { flush(); closePad(); }}>×</button></header>
      {held ? <Writer key={gen} className="pad-text" label="Notepad" value={text} onChange={set} {...focus}
        placeholder="Something in the way? Jot it here and stay on your thread." />
        : <p className="pad-wait">Opening…</p>}
      {GRIPS.map((g) => <div key={g} className={`pad-edge ${g}`} aria-hidden="true" onPointerDown={grab(g)} />)}
      <div className="pad-grip" aria-hidden="true" />
    </section>
  );
}

const phone = (): boolean => matchMedia("(max-width: 640px)").matches;

// Moves and resizes by writing the sheet's style directly, a frame at a time, so a drag never re-renders the Writer.
function usePlacement(box: { current: HTMLElement | null }): [(mode: "move" | Edges) => (e: ReactPointerEvent<HTMLElement>) => void, () => void] {
  // the reader scales the room, so the sheet's px are the room's, not the window's
  const z = useRef(1);
  const vw = () => innerWidth / z.current, vh = () => innerHeight / z.current;
  const rect = useRef<Rect | null>(loadRect());
  const paint = () => {
    const el = box.current;
    if (!el) return;
    if (phone()) { el.style.left = el.style.top = el.style.width = el.style.height = ""; return; }
    const r = rect.current = clampRect(rect.current ?? cornerRect(vw(), vh()), vw(), vh());
    el.style.left = `${r.x}px`; el.style.top = `${r.y}px`; el.style.width = `${r.w}px`; el.style.height = `${r.h}px`;
  };
  useLayoutEffect(() => {
    const fit = () => { z.current = zoomOf(box.current); paint(); };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);
  const grab = (mode: "move" | Edges) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || phone() || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    if (!rect.current) return;
    const el = e.currentTarget, start = { ...rect.current }, sx = e.clientX, sy = e.clientY, k = z.current;
    let px = sx, py = sy, raf = 0;
    const draw = () => {
      raf = 0;
      const dx = (px - sx) / k, dy = (py - sy) / k;
      rect.current = mode === "move" ? { ...start, x: start.x + dx, y: start.y + dy } : resize(start, mode, dx, dy, vw(), vh());
      paint();
    };
    const move = (ev: PointerEvent) => { px = ev.clientX; py = ev.clientY; if (!raf) raf = requestAnimationFrame(draw); };
    const up = () => {
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
      if (raf) { cancelAnimationFrame(raf); draw(); }
      saveRect(rect.current);
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };
  const home = () => { rect.current = null; saveRect(null); paint(); };
  return [grab, home];
}

// Text the server holds that isn't yours is merged with what you have and the Writer redrawn, so no later save drops it.
function usePadText(value: string): [string, (v: string) => void, () => void, { onFocus(): void; onBlur(): void }, number] {
  const [typed, setTyped] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const timer = useRef(0);
  const pending = useRef<string | null>(null);
  const sent = useRef<string | null>(null);
  const focused = useRef(false);
  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current === null) return;
    sent.current = pending.current;
    pad.save(pending.current).catch(() => toast("The notepad didn’t save. It is still here; type to try again.", 4200));
    pending.current = null;
  };
  const set = (v: string) => { setTyped(v); pending.current = v; clearTimeout(timer.current); timer.current = window.setTimeout(flush, 700); };
  useEffect(() => {
    // the Writer ignores a new value while focused
    if (typed === null) { if (focused.current) setGen((g) => g + 1); return; }
    if (value === typed) { if (!focused.current && pending.current === null) setTyped(null); return; }
    if (value === sent.current) return;
    const mine = pending.current ?? typed;
    const merged = mergePad(mine, value);
    if (merged !== mine) toast("Added lines from the notepad in another tab");
    if (merged === value) { pending.current = null; clearTimeout(timer.current); setTyped(null); }
    else set(merged);
    setGen((g) => g + 1);
  }, [value]);
  return [typed ?? value, set, flush, { onFocus: () => { focused.current = true; }, onBlur: () => { focused.current = false; flush(); } }, gen];
}
