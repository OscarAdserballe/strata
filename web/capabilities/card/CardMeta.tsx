import { cardPrompt } from "./drill-order.ts";
import { TYPE_LABEL } from "../../../shared/cards/faces.ts";
import FeedbackNote from "../feedback/FeedbackNote.tsx";
import { EditButton } from "./CardForm.tsx";
import type { FaceCard } from "./CardFace.tsx";

export interface CardMetaProps {
  card: FaceCard & { id: string; edited?: unknown };
  from?: string | null;
  anchor?: string | null;
  editing?: boolean;
  canEdit?: boolean;
  onEdit?: ((card: CardMetaProps["card"]) => void) | null;
  board?: string | null;
  where?: string | null;
  revealed?: boolean;
  extra?: Record<string, unknown> | null;
}

export default function CardMeta({ card, from, anchor, editing, canEdit = true, onEdit, board = null, where, revealed, extra }: CardMetaProps) {
  return (
    <div className="q-meta" onClick={(e) => e.stopPropagation()}>
      {from ? <span className="from">{from}</span> : null}
      {anchor ? <span className="anchor">{anchor}</span> : null}
      {card.mine
        ? <span className="mine">{card.mintOpen ? "open — yours to answer" : "yours"}</span>
        : <span>{TYPE_LABEL[card.type as string] || card.type}</span>}
      {onEdit && !editing && canEdit && !card.mintOpen ? <EditButton edited={!!card.edited} onClick={() => onEdit(card)} /> : null}
      <FeedbackNote key={card.id}
        payload={{ kind: "card", board, card: card.id, deck: card.deck,
          context: { front: cardPrompt(card), type: card.type, where: where ?? anchor ?? from ?? null, revealed: !!revealed, card, ...(extra || {}) } }} />
    </div>
  );
}
