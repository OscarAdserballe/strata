import React from "react";
import { MATH_SLOT, shieldMath, type MathSpan } from "./text.ts";
import { withImages } from "./images.tsx";

type Katex = typeof import("katex").default;

const { useState, useEffect, useMemo } = React;

let katex: Katex | undefined;
let mathLoading: Promise<Katex> | null | undefined;
export const loadMath = () => mathLoading ??= import("katex").then(m => { katex = m.default; return katex; })
  .catch(e => { mathLoading = null; throw e; });
// Typesetting dominated keystrokes in long threads, so results are cached (bounded, oldest out first).
const typeset = new Map<string, string>();
const TYPESET_KEEP = 4000;
export function katexHtml(tex: string, display?: boolean): string {
  const key = (display ? "D" : "I") + tex;
  let html = typeset.get(key);
  if (html !== undefined) return html;
  try {
    html = (katex as Katex).renderToString(tex, {
      displayMode: !!display, throwOnError: false, strict: false,
    });
  } catch { html = String(tex).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  if (typeset.size >= TYPESET_KEEP) typeset.delete(typeset.keys().next().value as string);
  typeset.set(key, html);
  return html;
}

export const Formula = React.memo(function Formula({ tex, display }: { tex: string; display?: boolean }) {
  const [ready, setReady] = useState(!!katex);
  useEffect(() => {
    let live = true;
    if (!katex) loadMath().then(() => { if (live) setReady(true); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const html = useMemo(() => ready ? { __html: katexHtml(tex, display) } : null, [ready, tex, display]);
  return html ? <span className={display ? "mathblock" : undefined} dangerouslySetInnerHTML={html} />
    : <span className={display ? "mathblock" : undefined}>{tex}</span>;
});
export function InlineMath({ tex }: { tex: string }) { return <Formula tex={tex} />; }
export function DisplayMath({ tex }: { tex: string }) {
  return <Formula tex={tex} display />;
}

export function withMath(text: string, spans: MathSpan[], kp: string): React.ReactNode[] {
  const out: React.ReactNode[] = [], re = new RegExp(MATH_SLOT);
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const span = spans[Number(m[1])];
    out.push(span ? <Formula key={kp + "m" + m[1]} tex={span.tex} display={span.display} /> : m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// The maths is lifted out before the asterisks are read, so a * inside a formula stays TeX.
export function MathText({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const parts = useMemo(() => withImages(text, inline), [text]);
  return <span className={className} style={style}>{parts}</span>;
}

function inline(text: string, kp: string): React.ReactNode[] {
  const { text: t, spans } = shieldMath(text), out: React.ReactNode[] = [];
  const re = /\*\*([^*]+?)\*\*|\*([^*]+?)\*/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(...withMath(t.slice(last, m.index), spans, kp + "t" + i));
    out.push(m[1] != null
      ? <strong key={kp + "b" + i}>{withMath(m[1], spans, kp + "b" + i)}</strong>
      : <em key={kp + "i" + i}>{withMath(m[2], spans, kp + "i" + i)}</em>);
    last = m.index + m[0].length; i++;
  }
  if (last < t.length) out.push(...withMath(t.slice(last), spans, kp + "t" + i));
  return out;
}
