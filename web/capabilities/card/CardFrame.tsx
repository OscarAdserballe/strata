import { useState } from "react";
import { anchorOf, anchorLabel } from "../../../shared/reading/anchors.ts";
import { facesOf } from "../../../shared/cards/faces.ts";
import CardTrail from "./CardTrail.tsx";
import CardMeta from "./CardMeta.tsx";
import CardForm from "./CardForm.tsx";
import CardHistory from "./CardHistory.tsx";
import CardDeleted from "./CardDeleted.tsx";
import { deckOf } from "./saveCard.ts";
import CardControls, { gradeActions } from "./CardControls.tsx";
import CardFace, { type FaceCard } from "./CardFace.tsx";
import type { CardMetaProps } from "./CardMeta.tsx";
import type { CardTrailProps } from "./CardTrail.tsx";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";


export type FrameCard = FaceCard & {
  id: string;
  deck?: string | null;
  source?: string;
  pairLabel?: string;
  edited?: unknown;
};

export interface CardFrameProps {
  card: FrameCard;
  cards: CardTrailProps["cards"];
  pos: number;
  revealed: boolean;
  picked: number | null;
  src?: { kind?: string } | null;
  onPick?: ((i: number) => void) | null;
  solo: boolean;
  onMintOpen?: ((card: FaceCard) => void) | null;
  onSpace?: (() => void) | null;
  onGrade?: ((got: boolean) => void) | null;
  onJump?: (() => void) | null;
  boardId?: string | null;
  onRestore?: (() => void) | null;
  seen?: CardTrailProps["seen"];
  onSeek?: CardTrailProps["onSeek"];
  keep?: CardTrailProps["keep"];
  onBench?: CardTrailProps["onBench"];
  onBenchWarm?: CardTrailProps["onBenchWarm"];
  editing: boolean;
  onEditOpen: (card: CardMetaProps["card"] | null) => void;
  onEditSave: (card: FrameCard, patch: CardFaces) => unknown;
  onDelete?: ((card: FrameCard) => unknown) | null;
  onUndelete?: ((card: FrameCard) => Promise<unknown>) | null;
}

function CardFrame({ card, cards, pos, revealed, picked, src, onPick, solo, onMintOpen, onSpace, onGrade, onJump, boardId, onRestore, seen, onSeek, editing, onEditOpen, onEditSave, onDelete, onUndelete, onBench, onBenchWarm, keep }: CardFrameProps) {
  const done = revealed || picked !== null;
  const [gone, setGone] = useState<{ card: FrameCard; at?: string } | null>(null);
  if (gone && !gone.at && card.id !== gone.card.id) setGone({ ...gone, at: card.id });
  else if (gone && gone.at && card.id !== gone.at) setGone(null);
  const inDeck = !card.mine && !!deckOf(card) && !onRestore;
  const remove = onDelete && inDeck
    ? () => Promise.resolve(onDelete(card)).then(() => setGone({ card })) : undefined;
  const a = anchorOf(card);
  const kind = (src && src.kind) || "text";
  const at = anchorLabel(kind, a);
  const here = solo ? (card.source || "—") : (at || card.source || "—");
  const jump = solo ? "go to where this lives"
    : !at ? "not in this source" : kind === "pdf" ? "show the page" : kind === "transcript" ? "show the moment" : "show the passage";
  return (
    <>
      <CardMeta card={card} from={solo ? card.pairLabel : null} anchor={here} board={boardId || null}
        where={here} revealed={done} editing={editing} onEdit={onEditOpen} />
      {editing ? (
        <CardForm card={card} faces={facesOf(card.type)}
          onSave={(patch) => onEditSave(card, patch)} onCancel={() => onEditOpen(null)} onDelete={remove} />
      ) : (<>
        <CardFace card={card} revealed={revealed} picked={picked} onPick={onPick}
          onQuestion={card.mintOpen && onMintOpen ? onMintOpen : undefined} />

        <CardControls
          actions={[
            card.mintOpen && onMintOpen ? { id: "write", label: "write the back", kbd: "space", live: true, on: () => onMintOpen(card) } : null,
            ...(!card.mintOpen && done && onGrade ? gradeActions(onGrade) : []),
            !card.mintOpen && !done && card.type !== "mcq" && onSpace
              ? { id: "reveal", label: "reveal", kbd: "space", live: true, on: () => onSpace() } : null,
            onRestore ? { id: "restore", label: "put it back", title: "back into its deck, exactly where it stood", on: onRestore } : null,
            done && (solo || at) && onJump ? { id: "jump", label: jump, kbd: "↵", on: () => onJump() } : null,
          ]}
          hints={[
            !card.mintOpen && !done && card.type === "mcq" ? { id: "pick", text: "answer", kbd: "1–4" } : null,
            solo ? { id: "solo", text: "back to the pages", kbd: "o" } : null,
          ]} />
        {gone && gone.at === card.id && onUndelete
          ? <CardDeleted key={gone.card.id} onRestore={() => onUndelete(gone.card).then(() => setGone(null))} /> : null}
      </>)}
      <div className="rule" />
      <CardTrail cards={cards} pos={pos} seen={seen} onSeek={onSeek} keep={keep} onBench={onBench} onBenchWarm={onBenchWarm} />
      {/* not lazy on scroll: IntersectionObserver never fires under the room's CSS zoom */}
      {done && !editing && inDeck ? <CardHistory key={card.id} card={{ id: card.id, course: deckOf(card) }} /> : null}
    </>
  );
}

export default CardFrame;
