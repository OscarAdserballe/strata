import { createPortal } from "react-dom";
import { useCramChunk, type CramCard } from "./cram-load.ts";
import { room, useHeld, useRoomHost } from "../../shell/room.ts";
import { closeCram } from "../../shell/screens.ts";
import { store } from "../../data/store.ts";
import { planKey } from "../../data/entities/boards.ts";
import { mintedToCards } from "../../capabilities/card/authored.ts";
import { setComposer, useComposer } from "../../capabilities/card/composing.ts";
import { compose, saveCardEdit, saveComposed } from "../../capabilities/card/doors.ts";
import "./cram.css";

export default function CramScreen() {
  const host = useRoomHost("veil");
  const { id, board, decks } = useHeld();
  const composer = useComposer();
  const chunk = useCramChunk();
  if (!host || !board || !id || !chunk) return null;
  const CramSurface = chunk.default;
  const title = (board.board && board.board.title) || "Strata";
  return createPortal(
    <CramSurface boardId={id} title={title} pairs={board.pairs} resources={board.resources}
      sections={board.sections} decks={decks} plan={store.get(planKey(id)) ?? board.plan} mine={mintedToCards(board.minted || [], id)}
      deckCards={room.deckCards} onEditSave={saveCardEdit} onDeleteCard={room.deleteCard}
      composer={composer} onComposerSave={saveComposed} onComposerCancel={() => setComposer(null)}
      onNewCard={(c: CramCard, q: string, a: string) => compose(c, q, a, { board: id, pair: c.mine ? c.pairId : null, label: title, asked: "asked during a cram" })}
      onJump={(c: CramCard) => { closeCram(); room.goToCardSource(c); }} onClose={closeCram} />,
    host);
}
