// What Strata does with no connection, in one list: the board download saves the reads, the outbox kinds hold the writes,
// and test/offline-contract.test.ts fails when a write or a screen's read is added without being placed here.

/** A write either waits on the device in an outbox kind and is sent when the wire is back, or needs the server, with why. */
export type Offline = { waits: string } | { online: string };

/** Every write the client makes, by its op's label (or the StrataAPI call that sends it). */
export const WRITES: Record<string, Offline> = {
  // the reading loop: review, cards, marks, notes and keeps
  "save that grade": { waits: "grade" },
  "save the card": { waits: "card-edit" },
  "save your card": { waits: "authored" },
  "save the card to Unfiled": { waits: "authored" },
  "keep that question": { waits: "keep" },
  "keep that highlight": { waits: "mark" },
  "save that note": { waits: "mark" },
  "send that reply": { waits: "mark" },
  "remove that highlight": { waits: "mark" },
  "save the notes": { waits: "notes" },
  "api.capture": { waits: "link" },

  "delete the card": { online: "a delete is held for its Undo, and an Undo offline could not be taken back on the server" },
  "put the card back": { online: "it undoes a delete the server made" },
  "file your cards": { online: "filing moves cards between decks the device may not hold" },
  "save the page": { online: "a live page's state is saved by the page itself, which reconnects on its own" },
  "send that feedback": { online: "feedback is read by the server" },
  "upload that image": { online: "the image's bytes are kept by the server, not on the device" },
  "api.tidyCard": { online: "the model formats the card" },
  "api.planDraft": { online: "the model drafts the units" },
  "api.chatStream": { online: "the model answers it" },
  "api.cardChatStream": { online: "the model answers it" },
  "api.captureFinish": { online: "the server reads the captions you paste" },
  "api.logout": { online: "it ends the session on the server" },
  "ask for that primer": { online: "the model draws the primer" },
  "start that": { online: "the model distils the source" },
  "clear the conversation": { online: "the conversation lives on the server" },

  // arranging boards and sources
  "rename that": { online: "sources are arranged online" },
  "delete that": { online: "sources are arranged online" },
  "file that": { online: "sources are arranged online" },
  "change those sections": { online: "sources are arranged online" },
  "make a board": { online: "boards are made online" },
  "rename the board": { online: "boards are arranged online" },
  "delete the board": { online: "boards are arranged online" },
  "save that": { online: "a project's plan is arranged online" },

  // the dashboard is a separate app, used at a desk
  "keep that item": { online: "the dashboard is used online" },
  "drop that item": { online: "the dashboard is used online" },
  "move that item": { online: "the dashboard is used online" },
  "add that thread": { online: "the dashboard is used online" },
  "save that thread": { online: "the dashboard is used online" },
  "move that thread": { online: "the dashboard is used online" },
  "save those notes": { online: "the dashboard is used online" },
  "send that to Dispatch": { online: "it wakes a Claude run" },
  "hand that to an agent": { online: "it wakes a Claude run" },
  "save the routine": { online: "the dashboard is used online" },
  "run the routine": { online: "it wakes a Claude run" },
  "save the notepad": { online: "the dashboard is used online" },
  "make an agent token": { online: "tokens are minted by the server" },
  "revoke that agent token": { online: "tokens are revoked by the server" },
};

/** The parts of a downloaded board the reads below need. */
export interface BoardShape {
  pairs?: { deck?: string | null }[];
  resources?: { id: string; kind: string; generation?: number }[];
  sections?: { id: string; resourceId: string }[];
}

/** Every read a downloaded board answers offline, as paths under the room's base; the download saves each one. */
export function offlineReads(id: string, b: BoardShape): string[] {
  const urls = ["/", "/api/boards", "/api/decks", "/api/register", "/api/review", `/api/boards/${id}`, `/api/boards/${id}/touched`];
  for (const p of b.pairs || []) if (p.deck) urls.push(`/api/decks/${p.deck}`, `/api/review/tree?course=${encodeURIComponent(p.deck)}`);
  for (const r of b.resources || []) {
    urls.push(`/api/boards/${id}/messages?resource=${encodeURIComponent(r.id)}`, `/api/boards/${id}/resources/${r.id}/raw`);
    if (r.kind !== "pdf") urls.push(`/api/boards/${id}/resources/${r.id}/preview`);
    // a primer or any HTML page opens live, under its generation
    if (r.kind === "html") urls.push(`/api/boards/${id}/resources/${r.id}/live${r.generation ? `?v=${r.generation}` : ""}`);
    urls.push(`/api/boards/${id}/resources/${r.id}/tree`);
  }
  for (const s of b.sections || []) urls.push(`/api/boards/${id}/resources/${s.resourceId}/tree?section=${encodeURIComponent(s.id)}`);
  return [...new Set(urls)];
}
