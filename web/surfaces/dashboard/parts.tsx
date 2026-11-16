import Markdown from "markdown-to-jsx";
import { imagesInMarkdown, imgProps } from "../../engines/prose/images.tsx";
import type { DashFrom } from "../../data/entities/dashboard.ts";

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

/** A thread's notes as Markdown, links opening elsewhere and the room's images drawn from the room. */
export function Notes({ text }: { text: string }) {
  return <div className="md"><Markdown options={{ forceBlock: true, disableParsingRawHTML: true,
    overrides: { a: { props: { target: "_blank", rel: "noopener" } }, img: { props: imgProps } } }}>{imagesInMarkdown(text)}</Markdown></div>;
}
