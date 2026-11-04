import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, PointerEvent, UIEvent } from "react";
import { mdBlocks } from "../../engines/prose/blocks.tsx";
import { withImages } from "../../engines/prose/images.tsx";
import { hasImages, imageRef, withoutImages } from "../../../shared/images/ref.ts";
import { dragsImages, imagesIn } from "../attach/attach.ts";
import { useTray } from "../attach/useTray.ts";
import Tray from "../attach/Tray.tsx";
import "../attach/lightbox.ts";
import { zoomOf } from "../../engines/zoom/zoom.ts";
import FeedbackNote from "../feedback/FeedbackNote.tsx";
import { begin, end } from "../../platform/rum.ts";
import { here } from "../../shell/here.ts";
import { registerAsk } from "./control.ts";
import { clearThread, draftOf, loadEarlier, sendTurn, setDraft, useThread } from "./useThread.ts";
import "./chat-dock.css";

export type Compose = (question: string, answer: string) => void;
export interface AskFeedback { board?: string | null; context?: Record<string, unknown>; [k: string]: unknown }

interface TurnProps { role: string; text: string; idx: number; question: string; feedback: AskFeedback; compose: Compose | null }

const Turn = memo(function Turn({ role, text, idx, question, feedback, compose }: TurnProps) {
  return (
    <div className={"turn " + (role === "user" ? "me" : "it")}>
      {role === "user" ? <div className="said-me">{withImages(text, trimLines)}</div> : <div className="said">{mdBlocks(text)}</div>}
      {role !== "user" ? <>
        {compose ? <button className="mint-c" title="make a card of this (c)"
          onClick={() => compose(question, text)}>↰ New card</button> : null}
        <FeedbackNote payload={{ kind: "chat", ...feedback, messageIdx: idx, context: { question, reply: text, ...(feedback.context || {}) } }} />
      </> : null}
    </div>
  );
});

const trimLines = (t: string) => t.replace(/^\n+|\n+$/g, "");

// a draft put back after a turn that did not finish gives its images back to the tray
const splitDraft = (d: string): { text: string; ids: string[] } => (hasImages(d) ? withoutImages(d) : { text: d, ids: [] });

// laying out every turn of a long thread at once blocked the main thread for seconds
const RECENT_TURNS = 24;
const THREAD_VH = 57;
const NO_FEEDBACK: AskFeedback = {};

export interface AskProps {
  thread: string | null;
  frame?: "room" | "float";
  name?: string;
  placeholder?: string;
  locked?: string | null;
  lazy?: boolean;
  onCompose?: Compose | null;
  feedback?: AskFeedback;
  solo?: boolean;
  splitW?: number;
}

interface Position { x: number; y: number }

function Ask({
  thread: key, frame = "float", name, placeholder = "ask…", locked = null, lazy = false,
  onCompose, feedback = NO_FEEDBACK, solo = false, splitW = 0,
}: AskProps) {
  const [open, setOpen] = useState(false);
  // a locked thread is not read at all: it could reveal the card's answer
  const { messages: thread, windowFrom, canLoadEarlier, turn } = useThread(key, !locked && (!lazy || open));
  // feedback is usually a fresh object literal; key the memo on its content
  const feedbackSig = JSON.stringify(feedback);
  const fb = useMemo(() => feedback, [feedbackSig]);
  const { reply, sending, error } = turn;
  const answering = !!reply;
  useEffect(() => { if (answering) end("ask.first"); }, [answering]);
  const [input, setInputState] = useState(() => splitDraft(draftOf(key)).text);
  const setInput = useCallback((v: string | ((was: string) => string)) => { setInputState((was) => { const next = typeof v === "function" ? v(was) : v; setDraft(key, next); return next; }); }, [key]);
  const tray = useTray();
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const backToLine = useCallback((d: string) => {
    const { text, ids } = splitDraft(d);
    setInputState(text);
    if (ids.length) tray.restore(ids);
  }, [tray.restore]);
  useEffect(() => { const { ids } = splitDraft(draftOf(key)); if (ids.length) tray.restore(ids); }, []);
  const shownKey = useRef(key);
  if (shownKey.current !== key) { shownKey.current = key; setInputState(splitDraft(draftOf(key)).text); }
  const trayKey = useRef(key);
  useEffect(() => {
    if (trayKey.current === key) return;
    trayKey.current = key; setAttachError("");
    const { ids } = splitDraft(draftOf(key));
    if (ids.length) tray.restore(ids); else tray.clear();
  }, [key]);
  const askRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  // follow the stream only while at the bottom; our own pin is told apart by its position
  const stuck = useRef(true), ourTop = useRef(-1);
  const pinBottom = useCallback((force?: boolean) => {
    const pin = () => {
      const el = threadRef.current; if (!el) return;
      if (force) stuck.current = true;
      if (!stuck.current) return;
      el.scrollTop = el.scrollHeight;
      ourTop.current = el.scrollTop;
    };
    // a hidden tab never paints, so rAF would leave a background reply above the fold
    if (document.hidden) setTimeout(pin, 0); else requestAnimationFrame(pin);
  }, []);
  const onThreadScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (Math.abs(el.scrollTop - ourTop.current) < 2) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => { if (open) pinBottom(); }, [reply, thread.length, error, open]);

  type Live = { open: boolean; locked: string | null; setInput: typeof setInput; add: (files: File[]) => void };
  const live = useRef({} as Live);
  live.current = { open, locked, setInput, add: tray.add };
  const focusLine = () => setTimeout(() => {
    const el = askRef.current; if (!el) return;
    el.focus(); el.setSelectionRange(el.value.length, el.value.length);
  }, 0);
  useEffect(() => {
    const prefill = (text: string) => { if (live.current.locked) return; live.current.setInput((v) => `${text}${v}`); setOpen(true); focusLine(); };
    const attach = (files: File[]) => { if (live.current.locked || !files.length) return; setAttachError(""); live.current.add(files); setOpen(true); focusLine(); };
    return registerAsk({
      open: () => {
        if (live.current.locked) return;
        const sel = window.getSelection?.();
        const quote = (sel ? sel.toString() : "").replace(/\s+/g, " ").trim();
        if (quote && !dockRef.current?.contains(sel!.anchorNode)) { sel!.removeAllRanges(); prefill(`“${quote}” — `); return; }
        setOpen(true); pinBottom(true); focusLine();
      },
      close: () => { setOpen(false); askRef.current?.blur(); },
      isOpen: () => live.current.open,
      prefill,
      attach,
    });
  }, []);

  async function send() {
    const words = input.trim();
    if ((!words && !tray.items.length) || sending || attaching || !key || locked) return;
    let ids: string[] = [];
    if (tray.items.length) {
      // the question goes only once its images are stored: it carries their ids
      setAttaching(true); setAttachError("");
      try { ids = await tray.ids(); }
      catch (e) { setAttachError((e as Error | null)?.message || "couldn't attach an image"); return; }
      finally { setAttaching(false); }
      if (shownKey.current !== key) return;
    }
    const text = [ids.map((id) => imageRef(id)).join("\n"), words].filter(Boolean).join("\n");
    tray.clear();
    setInputState(""); setOpen(true); pinBottom(true);
    begin("ask.first");
    await sendTurn(key, text, here());
    if (shownKey.current === key) backToLine(draftOf(key));
  }
  const pasted = (data: DataTransfer | null): boolean => {
    const files = imagesIn(data);
    if (!files.length || locked || !key) return false;
    setAttachError(""); tray.add(files); setOpen(true);
    return true;
  };
  const dockDrag = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => { if (dragsImages(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } },
    onDrop: (e: DragEvent<HTMLDivElement>) => { if (pasted(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); focusLine(); } },
  };
  const [clearing, setClearing] = useState("");
  async function clear() {
    if (!window.confirm("Clear this conversation? This cannot be undone.")) return;
    try { setClearing(""); await clearThread(key!); }
    catch (e) { setClearing("Couldn't clear that — " + ((e as Error | null)?.message || "try again")); }
  }

  const [threadVh, setThreadVh] = useState(() => { try { const v = +(localStorage.getItem("strata.thread.vh") || 0); return v >= 18 && v <= 82 ? v : THREAD_VH; } catch { return THREAD_VH; } });
  function startThreadDrag(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    // the pointer moves in painted px; vh resolves in layout px, so divide the zoom out first
    const z = zoomOf(e.currentTarget) || 1, perVh = window.innerHeight / 100;
    const sy = e.clientY, sv = threadVh; let latest = sv;
    const mv = (ev: globalThis.PointerEvent) => { latest = Math.max(18, Math.min(82, sv + (sy - ev.clientY) / z / perVh)); setThreadVh(latest); pinBottom(); };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); try { localStorage.setItem("strata.thread.vh", String(Math.round(latest))); } catch {} };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }
  const resetThreadVh = () => { setThreadVh(THREAD_VH); try { localStorage.removeItem("strata.thread.vh"); } catch {} };

  const drag = useRef<{ x: number; width: number; scale: number; side: number } | null>(null);
  const [width, setWidth] = useState(() => {
    try { return Math.max(280, Math.min(1600, Number(localStorage.getItem("strata.thread.width")) || 640)); }
    catch { return 640; }
  });
  function resizeWidth(value: number) {
    const next = Math.round(Math.max(280, Math.min(1600, value)));
    setWidth(next);
    try { localStorage.setItem("strata.thread.width", String(next)); } catch {}
  }
  function startWidthDrag(e: PointerEvent<HTMLDivElement>, side: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const dock = dockRef.current!;
    drag.current = { x: e.clientX, width: dock.offsetWidth, scale: dock.getBoundingClientRect().width / dock.offsetWidth, side };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveWidthDrag(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (d) resizeWidth(d.width + 2 * d.side * (e.clientX - d.x) / d.scale);
  }
  function widthKey(e: KeyboardEvent<HTMLDivElement>, side: number) {
    if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); resizeWidth(640); }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault(); e.stopPropagation();
      resizeWidth(dockRef.current!.offsetWidth + (e.key === "ArrowRight" ? 32 : -32) * side);
    }
  }
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // kept per frame: a position in the room's dock means nothing for the floating Ask
  const posKey = frame === "room" ? "strata.chat.position" : `strata.chat.position.${frame}`;
  const [position, setPosition] = useState<Position | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(posKey) as string);
      return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
    } catch { return null; }
  });
  const positionRef = useRef(position);
  positionRef.current = position;
  function savePosition(value: Position | null) {
    try {
      if (value) localStorage.setItem(posKey, JSON.stringify(value));
      else localStorage.removeItem(posKey);
    } catch { /* position still works without storage */ }
  }
  function resetPosition() { dragRef.current = null; setPosition(null); savePosition(null); }
  function dockScale() {
    const dock = dockRef.current!;
    return dock.offsetWidth ? dock.getBoundingClientRect().width / dock.offsetWidth : 1;
  }
  const roomOf = (dock: HTMLElement) => dock.closest(".panes") || document.documentElement;
  function fitPosition() {
    const dock = dockRef.current; if (!dock) return;
    const room = roomOf(dock).getBoundingClientRect();
    const scale = dockScale();
    dock.style.setProperty("--chat-max-height", `${Math.max(80, (Math.min(room.height, window.innerHeight) - 48) / scale)}px`);
    const current = positionRef.current;
    if (!current) return;
    const box = dock.getBoundingClientRect();
    const left = box.left - current.x * scale, top = box.top - current.y * scale;
    const x = Math.max((room.left + 8 - left) / scale, Math.min((room.right - 8 - box.width - left) / scale, current.x));
    const y = Math.max((room.top + 8 - top) / scale, Math.min((room.bottom - 8 - box.height - top) / scale, current.y));
    if (Math.abs(x - current.x) > 0.5 || Math.abs(y - current.y) > 0.5) {
      positionRef.current = { x, y };
      setPosition({ x, y });
    }
  }
  // re-fit only on what moves the dock; without deps this forced two layouts per render
  const expanded = open && !locked && !!(thread.length || reply || sending || error || tray.items.length);
  useLayoutEffect(() => { fitPosition(); }, [position, expanded, width, splitW, solo]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(fitPosition);
    const dock = dockRef.current!;
    observer.observe(dock);
    observer.observe(dock.parentElement!);
    observer.observe(roomOf(dock));
    window.addEventListener("resize", fitPosition);
    return () => { observer.disconnect(); window.removeEventListener("resize", fitPosition); };
  }, []);
  function startMove(e: PointerEvent<HTMLElement>) {
    if (e.button !== 0 || (e.target as Element).closest("button:not(.chat-move)")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  }
  function move(e: PointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const current = positionRef.current || { x: 0, y: 0 };
    const scale = dockScale();
    setPosition({ x: current.x + (e.clientX - d.x) / scale, y: current.y + (e.clientY - d.y) / scale });
    dragRef.current = { ...d, x: e.clientX, y: e.clientY };
  }
  function endMove(e: PointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    savePosition(positionRef.current);
  }
  function moveWithKeys(e: KeyboardEvent<HTMLButtonElement>) {
    const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!delta) return;
    e.preventDefault(); e.stopPropagation();
    const current = positionRef.current || { x: 0, y: 0 };
    const step = (e.shiftKey ? 40 : 10) / dockScale();
    setPosition({ x: current.x + delta[0] * step, y: current.y + delta[1] * step });
  }
  const moveEvents = { onPointerDown: startMove, onPointerMove: move, onPointerUp: endMove,
    onPointerCancel: endMove, onLostPointerCapture: endMove };

  const [shown, setShown] = useState(RECENT_TURNS);
  useEffect(() => { setShown(RECENT_TURNS); }, [key]);
  const from = Math.max(0, thread.length - shown);
  // earlier turns add height above; keep the reader's position from the bottom
  const keepFromBottom = useRef<number | null>(null);
  const showEarlier = () => {
    const el = threadRef.current;
    keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setShown((n) => n + RECENT_TURNS);
  };
  useLayoutEffect(() => {
    const el = threadRef.current, keep = keepFromBottom.current;
    if (el && keep != null) { el.scrollTop = el.scrollHeight - keep; keepFromBottom.current = null; }
  }, [shown]);
  const keystrokes = useRef(0);
  const composer = useRef(onCompose);
  composer.current = onCompose;
  const compose = useCallback((question: string, answer: string) => composer.current?.(question, answer), []);
  const say = locked || (sending ? "thinking…" : attaching ? "sending images…" : tray.items.length ? "ask about the image…" : placeholder);
  return (
<div className={"askwrap" + (frame === "float" ? " float" : "") + (position ? " moved" : "")}
  style={frame === "room" ? { left: solo ? 0 : `min(${splitW + 6}px, max(0px, calc(100% - 380px / var(--room, 1))))` } : undefined}>
  <div ref={dockRef} className={"ask chat-resizable" + (expanded ? " open" : "")} {...dockDrag}
    style={{ ...(position ? { transform: `translate(${position.x}px, ${position.y}px)` } : {}),
      ...(expanded ? { width, maxWidth: "100%" } : {}) }}>
    {expanded ? [-1, 1].map(side => <div key={side}
      className={"chat-width-grip " + (side < 0 ? "left" : "right")}
      role="separator" aria-label="Chat width" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={280} aria-valuemax={1600} aria-valuenow={width}
      title="Drag to resize width · double-click to reset · arrow keys to adjust"
      onPointerDown={e => startWidthDrag(e, side)} onPointerMove={moveWidthDrag}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => resizeWidth(640)} onKeyDown={e => widthKey(e, side)} />) : null}
    {expanded ? (
      <div className="thread">
        <div className="tgrip" onPointerDown={startThreadDrag} onDoubleClick={resetThreadVh}
          title="drag to resize · double-click for the default"><i /></div>
        <div className="thead" {...moveEvents} title="drag to move chat">
          {thread.length ? <button disabled={sending} className="chat-clear" onClick={clear}
            title="clear this conversation">clear</button> : null}
          <span className="chat-thread-name">{name || "this thread"}</span>
          <span className="grow" />
          <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close chat" title="close chat (esc)">×</button>
        </div>
        <div className="turns" ref={threadRef} onScroll={onThreadScroll} style={{ maxHeight: threadVh + "vh" }}>
          {from > 0
            ? <button className="chat-earlier" onClick={showEarlier}>Show {Math.min(from, RECENT_TURNS)} earlier turn{Math.min(from, RECENT_TURNS) === 1 ? "" : "s"}</button>
            : canLoadEarlier ? <button onClick={() => loadEarlier(key!).catch(() => setClearing("Couldn't load earlier messages"))}>Load earlier messages</button> : null}
          {thread.slice(from).map((m, j) => {
            const i = from + j;
            let qn = "";
            if (m.role !== "user") for (let k2 = i - 1; k2 >= 0; k2--) if (thread[k2].role === "user") { qn = thread[k2].text; break; }
            return (
            <React.Fragment key={m.idx ?? `at${i}`}>
              {windowFrom > 0 && m.idx === windowFrom
                ? <div className="forgot" title="the conversation ran past the context budget">the model no longer remembers above this</div>
                : null}
              <Turn role={m.role} text={m.text} idx={m.idx} question={qn} feedback={fb} compose={onCompose ? compose : null} />
            </React.Fragment>
            );
          })}
          {reply && sending ? <div className="turn it"><div className="said">{mdBlocks(reply, true)}</div></div> : null}
          {sending && !reply ? <div className="turn it"><div className="said waiting"><span className="kg-pulse">◆</span> thinking…</div></div> : null}
          {!sending && (error || clearing) ? <div className="turn it ask-error" role="alert">
            {reply ? <div className="said">{mdBlocks(reply)}</div> : null}
            <div className="said waiting">{error || clearing}</div>
          </div> : null}
        </div>
      </div>
    ) : sending ? (
      <div className="said one">{reply ? mdBlocks(reply, true) : <span className="waiting"><span className="kg-pulse">◆</span> thinking…</span>}</div>
    ) : null}
    {!locked ? <Tray items={tray.items} note={attachError || tray.note} onRemove={tray.remove} /> : null}
    <div className="line">
      <button className="chat-move" aria-label="Move chat" title="drag to move · arrow keys to nudge"
        {...moveEvents} onKeyDown={moveWithKeys} onKeyUp={() => savePosition(positionRef.current)}>⠿</button>
      <input ref={askRef} value={input} disabled={sending || attaching || !!locked || !key} aria-label="Ask"
        onPaste={(e) => { if (pasted(e.clipboardData)) e.preventDefault(); }}
        placeholder={say}
        onFocus={() => { if (lazy || thread.length || error) { setOpen(true); pinBottom(true); } }}
        onChange={(e) => {
          setInput(e.target.value);
          if (++keystrokes.current % 5 === 0) { begin("chat.key", e.timeStamp); end("chat.key"); }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void send(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); e.currentTarget.blur(); }
        }} />
      {position ? <button className="k chat-reset" onClick={resetPosition} title="reset chat position" aria-label="Reset chat position">↙</button> : null}
      {thread.length && !open && !locked
        ? <button className="k" onClick={() => { setOpen(true); pinBottom(true); }} title="show the thread">{Math.ceil(thread.length / 2)} ↑</button>
        : <span className="k">/</span>}
    </div>
  </div>
</div>
  );
}

export default Ask;
