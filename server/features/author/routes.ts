// `back` always comes from the person; nothing here may write it from a model reply.

import { logEvent } from "../../platform/events/events.ts";
import { isVariant } from "./variants.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now, genId } from "../../platform/db/sql.ts";
import type { MintedRow } from "../../platform/db/rows.ts";
import { deckForPair } from "../decks/decks.ts";
import { deMaterializeQuestion, enrollQuestion, syncMaterializedQuestion } from "./lifecycle.ts";
import { boardState } from "../boards/state.ts";
import { mintedOut } from "./authored.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
import { inferSourceAnchor } from "../../../shared/reading/anchors.ts";

const autoEnroll = (m: MintedRow, boardId: string, ssn?: string | null): string | null => {
  if (m.state !== "closed" || !String(m.back ?? "").trim()) return null;
  const pair = m.pair_id ? q.pair.get(boardId, m.pair_id) : null;
  // a card made on a source's words belongs to that source, whether or not it was read with a deck
  const slug = pair ? deckForPair(boardId, pair) : null;
  return slug ? enrollQuestion(m, slug, boardId, ssn) : null;
};

export const mintRoutes: Route[] = [
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/minted\/file$/, async ({ res, ssn, params, body, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ ids?: string[]; deck?: string }>();
    const name = String(b.deck ?? "").trim().slice(0, 80);
    const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string") : [];
    if (!ids.length) { sendJson(res, 400, { error: "nothing to file" }); return; }
    commit(() => {
      for (const mid of ids) if (q.minted.get(boardId, mid)) q.setMintedDeck.run(name || null, now(), boardId, mid);
      logEvent(db, APP, "mint_file", { board: boardId, deck: name || null, n: ids.length }, ssn);
      return { status: 200, body: { state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/minted$/, async ({ res, ssn, params, body, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ front?: string; variant?: string; pairId?: string | null; source?: string; meta?: Record<string, unknown>; opensAt?: number; back?: string; state?: string }>();
    const front = String(b.front ?? "").trim();
    if (!front) { sendJson(res, 400, { error: "a card needs a front" }); return; }
    if (!isVariant(b.variant)) { sendJson(res, 400, { error: "unknown variant" }); return; }
    const id = genId("m-"); const t = now();
    const state = b.state === "closed" ? "closed" : "open";
    const pair = b.pairId ? q.pair.get(boardId, b.pairId) : null;
    const resource = pair?.resource_id ? q.resource.get(boardId, pair.resource_id) : null;
    const pages = resource?.kind === "pdf" ? JSON.parse(q.pageTextOf.get(resource.id)?.page_text ?? "[]") : [];
    const inferred = resource && !b.meta?.anchorExplicit ? inferSourceAnchor(resource.kind ?? "text", resource.text ?? "", pages,
      [String(b.back ?? ""), front, String(b.meta?.answer ?? "")]) : null;
    commit(() => {
      q.insMinted.run(id, boardId, b.pairId ?? null, String(b.variant), state, front,
        state === "closed" ? String(b.back ?? "") : null, inferred || String(b.source ?? ""),
        JSON.stringify(b.meta ?? {}), Number(b.opensAt ?? 0), t, t);
      const made = q.minted.get(boardId, id);
      if (made) autoEnroll(made, boardId, ssn);
      logEvent(db, APP, "mint_capture", { board: boardId, variant: b.variant, state }, ssn);
      return { status: 201, body: { id, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/minted$/, ({ res, params }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    sendJson(res, 200, { minted: (boardState(boardId) as { minted: unknown }).minted });
  }),

  // The body is read first, so nothing awaits between the reads below and the commit.
  route("PATCH", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/minted\/([a-zA-Z0-9_-]+)$/, async ({ res, ssn, params, body, commit, ifMatch }) => {
    const [boardId, mid] = params;
    const b = await body<{ back?: string; state?: string; meta?: Record<string, unknown>; opensAt?: number; front?: string; source?: string }>();
    const row = q.minted.get(boardId, mid) as MintedRow | undefined;
    if (!row) { sendJson(res, 404, { error: "no such card" }); return; }
    if (b.source !== undefined && typeof b.source !== "string") { sendJson(res, 400, { error: "Source location must be text." }); return; }
    const front = b.front === undefined || !String(b.front).trim() ? row.front : String(b.front).trim();
    const back = b.back === undefined ? row.back : String(b.back);
    const state = b.state === "closed" || b.state === "open" ? b.state : row.state;
    if (state === "closed" && !String(back ?? "").trim()) { sendJson(res, 400, { error: "a card closes on YOUR sentence, and there isn't one" }); return; }
    const meta = b.meta === undefined ? row.meta : JSON.stringify(b.meta);
    const source = b.source?.trim() || row.source;
    const text = b.front !== undefined || b.back !== undefined;
    commit(() => {
      if (text) {
        const cur = q.minted.get(boardId, mid) as MintedRow | undefined;
        ifMatch(cur?.rev ?? 0, () => (cur ? mintedOut(cur) : null));
      }
      q.updMinted.run(state, front, back, meta, Number(b.opensAt ?? row.opens_at), now(), boardId, mid);
      if (source !== row.source) q.setMintedSource.run(source, now(), boardId, mid);
      if (row.card_id) {
        if (state === "open") deMaterializeQuestion(row.card_id, boardId, mid, ssn);
        else syncMaterializedQuestion({ ...row, front, back, state, source } as typeof row, boardId);
      } else if (state === "closed") {
        const closed = q.minted.get(boardId, mid);
        if (closed) autoEnroll(closed, boardId, ssn);
      }
      if (state !== row.state) logEvent(db, APP, "mint_" + state, { board: boardId, variant: row.variant, chars: String(back ?? "").length }, ssn);
      return { status: 200, body: { state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("DELETE", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/minted\/([a-zA-Z0-9_-]+)$/, ({ res, ssn, params, commit }) => {
    const [boardId, mid] = params;
    const row = q.minted.get(boardId, mid) as MintedRow | undefined;
    if (!row) { sendJson(res, 404, { error: "no such card" }); return; }
    commit(() => {
      if (row.card_id) deMaterializeQuestion(row.card_id, boardId, mid, ssn);
      q.delMinted.run(boardId, mid);
      logEvent(db, APP, "mint_drop", { board: boardId, variant: row.variant, was: row.state }, ssn);
      return { status: 200, body: { state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),
];
