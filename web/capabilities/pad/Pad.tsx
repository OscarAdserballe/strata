// The notepad: a pop-open Writer for stray frictions on every screen of the room and the dashboard.
import "./pad.css";
import { useEffect, useRef, useState } from "react";
import { mergePad, PAD_KEY, pad, usePad } from "../../data/entities/pad.ts";
import { store } from "../../data/store.ts";
import { toast } from "../../shell/layers.ts";
import Writer, { loadWriter } from "../write/Writer.tsx";
import { closePad, isPadKey, togglePad, usePadOpen } from "./pad.ts";

// One listener however many pads are mounted.
let keys = 0;
const onKey = (e: KeyboardEvent): void => { if (isPadKey(e)) { e.preventDefault(); e.stopPropagation(); togglePad(); } };

export default function Pad() {
  const open = usePadOpen();
  useEffect(() => {
    if (!keys++) document.addEventListener("keydown", onKey, true);
    return () => { if (!--keys) document.removeEventListener("keydown", onKey, true); };
  }, []);
  return <>
    <button className={"pad-chip" + (open ? " on" : "")} aria-expanded={open} aria-controls="strata-pad" title="Notepad (⌘;)"
      onPointerDown={() => void loadWriter().catch(() => {})} onClick={togglePad}>Notepad</button>
    {open ? <Sheet /> : null}
  </>;
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
  return (
    <section ref={box} id="strata-pad" className="pad-sheet" aria-label="Notepad"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); flush(); closePad(); } }}>
      <header><b>Notepad</b><span>stray frictions, for later</span>
        <button className="pad-x" aria-label="Close the notepad" onClick={() => { flush(); closePad(); }}>×</button></header>
      {held ? <Writer key={gen} className="pad-text" label="Notepad" value={text} onChange={set} {...focus}
        placeholder="Something in the way? Jot it here and stay on your thread." />
        : <p className="pad-wait">Opening…</p>}
    </section>
  );
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
