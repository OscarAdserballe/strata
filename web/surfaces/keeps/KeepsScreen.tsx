import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useKeepsChunk, type KeepCard } from "./keeps-load.ts";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";
import { room, useHeld, useRoomHost } from "../../shell/room.ts";
import { closeKeeps, descendKeeps, screensNow, setKeepsEditing, useScreens } from "../../shell/screens.ts";
import { StrataAPI } from "../../data/api.ts";
import { useBoardList } from "../../data/entities/register.ts";
import Composer from "../../capabilities/card/Composer.tsx";
import { setComposer, useComposer } from "../../capabilities/card/composing.ts";
import { compose as composeCard, saveCardEdit, saveComposed } from "../../capabilities/card/doors.ts";
import { registerLadder } from "../../capabilities/keys/registry.ts";

const fromLibrary = () => { const f = screensNow().keeps; return !!(f.length && f[0].library); };
// no board prop: /api/log bumps touched_at for it, and curating must not reorder the library
const editSave = (c: KeepCard, patch: CardFaces) => saveCardEdit(c, patch).then((merged) => {
  const f = screensNow().keeps, t = f[f.length - 1];
  StrataAPI.log("card_edit", { at: (t && t.boardId) || room.activeId() || null,
    deck: c.deck || null, card: c.id, faces: Object.keys(patch).join(","), bench: true });
  return merged;
});
const compose = (home: Record<string, unknown> | null, card: unknown = null) => (q: string, a: string) =>
  composeCard(card, q, a, { asked: "asked over the keeps", ...home });

export default function KeepsScreen() {
  const { keeps: frames, keepsEditing: editing, review, cram } = useScreens();
  const lib = !!(frames.length && frames[0].library);
  const host = useRoomHost(lib ? "bench-lib" : "panes");
  const { id: activeId, board } = useHeld();
  const boards = useBoardList();
  const composer = useComposer();
  const chunk = useKeepsChunk();
  useEffect(() => registerLadder(() => ({ "bench-lib": { open: fromLibrary, close: closeKeeps } })), []);
  const top = frames[frames.length - 1] as typeof frames[number] & { title?: string };
  if (!host || !top || !chunk) return null;
  const { default: DeckKeeps, BoardKeeps, LibraryKeeps } = chunk;
  const boardTitle = (board && board.board && board.board.title) || "Strata";
  const common = {
    onBoardState: room.boardState, onDeckChanged: room.deckChanged, editing, setEditing: setKeepsEditing, onEditSave: editSave,
    onDeleteCard: room.deleteCard, onRestoreCard: room.restoreCard, onClose: closeKeeps,
  };
  const bid = top.boardId || activeId, title = top.title;
  const slug = String(top.slug).split("/")[0];
  const deckPair = !top.board && bid === activeId && board ? (board.pairs || []).find((p: any) => p.deck && String(p.deck).split("/")[0] === slug) : null;
  const drawn = top.library
    ? <LibraryKeeps key="lib" {...common}
        onOpenBoard={(id: string, t: string) => descendKeeps({ board: true, boardId: id, title: t })} onCompose={compose(null)} />
    : top.board
    ? <BoardKeeps key={"bb:" + bid} {...common} boardId={bid!}
        title={title || (bid === activeId ? boardTitle : (boards.find((b) => b.id === bid) || { title: "" }).title || "")}
        onOpenDeck={(s: string, label: string) => descendKeeps({ slug: s, title: label, boardId: bid ?? undefined })}
        onCompose={compose({ board: bid, label: title || boardTitle })} />
    : <DeckKeeps key={top.slug} {...common} slug={slug}
        title={title || (deckPair && deckPair.label) || top.slug}
        minted={bid === activeId ? ((board && board.minted) || []) : null}
        pairs={bid === activeId ? ((board && board.pairs) || []) : null}
        boardId={bid}
        onCompose={compose({ board: bid, pair: deckPair ? deckPair.id : null, label: title || slug }, { course: slug })}
        composing={!!composer} />;
  const form = composer && !review && !cram
    ? <div className="bench-compose"><Composer front0={composer.front} answer={composer.answer} anchor={composer.anchor}
        closing={!!composer.mintId} review onSave={saveComposed} onCancel={() => setComposer(null)} /></div> : null;
  return createPortal(lib
    ? <div className="bench-lib">{drawn}{form}</div>
    : <div className="bench-at" onDragOver={(e) => room.panesDrag.onDragOver(e)} onDragLeave={(e) => room.panesDrag.onDragLeave(e)}
        onDrop={(e) => room.panesDrag.onDrop(e)}>{drawn}{form}</div>, host);
}
