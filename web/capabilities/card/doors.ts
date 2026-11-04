import { flushSync } from "react-dom";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { store } from "../../data/store.ts";
import { authored } from "../../data/entities/authored.ts";
import { reviewStrip } from "../../data/entities/review.ts";
import { ATTEMPT_DEADLINE_MS, mintKey } from "../../data/mutate.ts";
import { quoteAnchor } from "../../../shared/reading/anchors.ts";
import { toast } from "../../shell/layers.ts";
import { storeKeyOf } from "../ask/useThread.ts";
import type { ComposedCard } from "./Composer.tsx";
import { composerNow, setComposer, type FoldPlace } from "./composing.ts";
import { deckOf, saveAuthored, saveCard } from "./saveCard.ts";
import { withDeadline } from "./tidy.ts";

type Wire = any;

export interface CardRoom {
  activeId(): string | null;
  setBoard(state: Wire): void;
  patchCard(deck: string, id: string, card: Wire): void;
  /** a card joined this deck: the reader reads it again, so the card sits on its words at once */
  deckGrew(deck: string): void;
  at(): { pair: Wire; askKey: string | null; page: HTMLElement | null; prose: HTMLElement | null };
  clearColumn(): void;
}
let room = {} as CardRoom;
export function bindCardRoom(r: CardRoom): void { room = r; }

function toastWhy(e: unknown, said: string) { console.warn("[strata]", said, e); toast(StrataWhy(e, said), 4200); }

export function captureReply(): void {
  if (composerNow()) return;
  const { askKey } = room.at();
  // a board's canned greeting (idx 0) is not an exchange
  const th = ((askKey && store.get<Wire>(storeKeyOf(askKey))?.messages) || []).filter((m: Wire) => m.idx > 0 || m.role === "user");
  let ai = -1;
  for (let i = th.length - 1; i >= 0; i--) if (th[i].role !== "user") { ai = i; break; }
  if (ai < 0) { toast("nothing to capture yet — ask something first"); return; }
  let question = "";
  for (let i = ai - 1; i >= 0; i--) if (th[i].role === "user") { question = th[i].text; break; }
  openComposer(question, th[ai].text);
}
function visiblePage(sc: HTMLElement | null) {
  if (!sc) return null;
  const top = sc.getBoundingClientRect().top;
  let best: Element | null = null, bd = Infinity;
  sc.querySelectorAll('[id^="pg-"]').forEach((el2) => {
    const d = Math.abs(el2.getBoundingClientRect().top - top);
    if (d < bd) { bd = d; best = el2; }
  });
  return best ? +(best as Element).id.slice(3) : null;
}
export function openComposer(question: string, answer: string, existing?: Wire): void {
  const { pair: p, page, prose } = room.at();
  room.clearColumn();
  if (existing) {
    setComposer({ front: existing.front, answer, mintId: existing.mintId, pairId: existing.pairId, source: existing.source, anchor: existing.source || null });
  } else {
    const pg = visiblePage(page);
    const label = p && !p.isHome ? (p.label || "") : "";
    const selection = window.getSelection()?.toString().trim();
    const selectedHere = selection && page?.contains(window.getSelection()?.anchorNode ?? null);
    const blocks = [...(prose?.querySelectorAll("[data-b]") || [])];
    const top = page?.getBoundingClientRect().top || 0;
    const visible = blocks.find(el => el.getBoundingClientRect().bottom > top + 8);
    const clean = visible?.cloneNode(true) as Element | undefined;
    clean?.querySelectorAll(".ftick, .fpeek").forEach(el => el.remove());
    const excerpt = selectedHere ? selection : clean?.textContent?.trim().split(/\s+/).slice(0, 32).join(" ");
    const source = label ? (pg ? "asked at " + label + " · p. " + pg : excerpt ? quoteAnchor(excerpt) : "asked at " + label) : "asked on the board";
    setComposer({ front: question, answer, mintId: null, pairId: p && !p.isHome ? p.id : null, source, anchor: label ? label + (pg ? " · p. " + pg : "") : null, requestId: mintKey() });
  }
}
/** A card you write under the words you picked: its source is those words, so it is asked there. */
export function openFoldCard(at: FoldPlace, kind: string): void {
  const { pair: p } = room.at();
  const source = (kind === "pdf" && at.page ? "p. " + at.page + " · " : "") + quoteAnchor(at.quote);
  setComposer({ front: "", answer: "", mintId: null, pairId: p && !p.isHome ? p.id : null, source,
    anchor: p && !p.isHome ? p.label || null : null, requestId: mintKey(), fold: at });
}
export async function compose(card: Wire, front = "", answer = "", home: Wire = null): Promise<void> {
  let where: Wire = null;
  const course = card?.course || (card && !card.mine ? deckOf(card) : null);
  try { if (course) where = await StrataAPI.reviewTree(course); } catch (e) { /* a source-less card belongs in Unfiled */ }
  if (!where?.board && home?.board) where = { ...home, home: true };
  const id = where?.board || "inbox";
  const unfiled = !where?.pair && !where?.home;
  const label = unfiled ? "Unfiled" : (where && where.label) || card?.courseTitle || "this card";
  setComposer({ front, answer, mintId: null, boardId: id, pairId: (where && where.pair) || null,
    source: card?.source || ((home && home.asked) || "asked during review") + " · " + label, anchor: label, unfiled, requestId: mintKey() });
}
export async function saveComposed(fields: ComposedCard): Promise<void> {
  const { front, back, source } = fields as { front: string; back?: string; source?: string };
  const c = composerNow(); const id = c && (c.boardId || room.activeId()); if (!c || !id) return;
  try {
    if (c.unfiled) {
      await authored.personal({ front, back: back as string, source: source || c.source, requestId: c.requestId as string });
      setComposer(null);
      reviewStrip.refresh();
      toast("Saved to Unfiled and kept for review.");
      return;
    }
    const r: Wire = c.mintId
      ? await authored.update(id, c.mintId, { front, back, source, state: "closed" })
      // hot: the back was written with the answer on screen
      : await authored.create(id, { front, variant: "bare", pairId: c.pairId, source: source || c.source, meta: { answer: c.answer, hot: !!back, anchorExplicit: !!source }, state: back ? "closed" : "open", back: back || undefined }, { draftKey: c.requestId });
    // flushSync: a setState after an await renders separately, closing the form over the old board
    flushSync(() => { if (id === room.activeId()) room.setBoard(r.state); setComposer(null); });
    const mid = c.mintId || r.id;
    const made = ((r.state && r.state.minted) || []).find((m: Wire) => m.id === mid && m.cardId);
    const enrolled = back && !!made;
    if (made) room.deckGrew(String(made.cardId).split("/")[0]);
    toast(back
      ? (enrolled ? "card saved — enrolled for review" : "card saved — choose its deck to enrol it")
      : "kept open — review starts when you close it");
  } catch (e) { toastWhy(e, "couldn't save that card"); throw e; }
}

export function saveCardEdit(c: Wire, patch: Record<string, unknown>): Promise<Wire> {
  const saved = c.mine && c.mintId
    ? saveAuthored(c.boardId || room.activeId(), c.mintId, patch)
      .then((r) => { if (r && r.state) room.setBoard(r.state); return { ...c, ...patch }; })
    : saveCard(c, patch).then(
    (merged) => { room.patchCard(deckOf(c), c.id, merged); return merged; },
    (e) => { if (e && e.theirs) room.patchCard(deckOf(c), c.id, e.theirs); throw e; });
  // the editor waits one attempt's deadline; the op keeps retrying and patches the lists when it lands
  return withDeadline(saved, ATTEMPT_DEADLINE_MS, "Saving",
    "still saving: it lands when the connection is back");
}
export function editCard(c: Wire, patch: Record<string, unknown>, drill: { setEditing(id: null): void; logCard(event: string, extra?: Record<string, unknown>): void }): Promise<void> {
  return saveCardEdit(c, patch).then(() => {
    drill.setEditing(null);
    drill.logCard("card_edit", { ...(c.mine ? { mine: true } : {}), faces: Object.keys(patch).join(",") });
  });
}
