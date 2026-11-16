import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import type { DashFrom } from "../../data/entities/dashboard.ts";
import { imagesInMarkdown, imgProps } from "../../engines/prose/images.tsx";

export const hm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function age(at: number): string {
  const m = Math.max(1, Math.round((Date.now() - at) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : m < 1440 * 14 ? `${Math.round(m / 1440)} d` : `${Math.round(m / 10080)} w`;
}
/** getRandomValues, not randomUUID: the room is also reached over plain http. */
export const newThreadId = (): string => "t_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

const kindOf = (src: string): string => /linear|TRY-|RCP-|GD-/i.test(src) ? "linear" : /slack|#/i.test(src) ? "slack"
  : /github|PR\b/i.test(src) ? "github" : /notion/i.test(src) ? "notion" : /^you$/i.test(src) ? "you" : /agent|routine|claude/i.test(src) ? "agent" : "";
/** Where a thing came from: a coloured square by kind, then its name, linked when it has a place. */
export function Src({ from }: { from: DashFrom | null | undefined }) {
  const s = from?.source || "You";
  const inner = <><i />{s}</>;
  return from?.url ? <a className={`src ${kindOf(s)}`} href={from.url} target="_blank" rel="noopener">{inner}</a> : <span className={`src ${kindOf(s)}`}>{inner}</span>;
}

/** A thread's notes as Markdown, links opening elsewhere. */
export function Notes({ text }: { text: string }) {
  return <div className="md"><Markdown options={{ forceBlock: true, disableParsingRawHTML: true,
    overrides: { a: { props: { target: "_blank", rel: "noopener" } }, img: { props: imgProps } } }}>{imagesInMarkdown(text)}</Markdown></div>;
}

/**
 * Text you type that saves itself: shown as typed, sent a pause after the last key, and taken from the server only
 * while the field is not focused, so a save's answer never rewrites what is being typed.
 */
export function useTyped(value: string, save: (v: string) => void, wait = 700): [string, (v: string) => void, () => void, { onFocus(): void; onBlur(): void }] {
  const [typed, setTyped] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const timer = useRef(0);
  const pending = useRef<string | null>(null);
  const flush = () => { clearTimeout(timer.current); if (pending.current !== null) { save(pending.current); pending.current = null; } };
  const set = (v: string) => { setTyped(v); pending.current = v; clearTimeout(timer.current); timer.current = window.setTimeout(flush, wait); };
  // out of the field and caught up: hand it back to the server, which may hold another device's edit
  useEffect(() => { if (!focused && typed !== null && pending.current === null && value === typed) setTyped(null); }, [value, typed, focused]);
  useEffect(() => () => flush(), []);
  const held = { onFocus: () => setFocused(true), onBlur: () => { flush(); setFocused(false); } };
  return [typed ?? value, set, flush, held];
}

/** A textarea as tall as what it holds. */
export function Grow(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    // collapsing to measure shortens the page under the scroller, which clamps its scroll and jumps the caret away
    const kept: [Element, number][] = [];
    for (let p = t.parentElement; p; p = p.parentElement) if (p.scrollTop) kept.push([p, p.scrollTop]);
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
    for (const [p, top] of kept) p.scrollTop = top;
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...props} />;
}
