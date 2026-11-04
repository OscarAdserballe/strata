import { mdBlocks } from "../../engines/prose/blocks.tsx";
import { MathText } from "../../engines/prose/math.tsx";
import { tex } from "../../engines/prose/text.ts";
import { cardPrompt, type DrillCard } from "./drill-order.ts";
// a click on a pasted screenshot on a face opens it whole, and does not turn the card over
import "../attach/lightbox.ts";

export interface FaceCard extends DrillCard {
  options?: string[]; correct?: number; explanation?: string;
  back?: string;
  title?: string; cue?: string; trick?: string; trap?: string; solution?: string;
  mine?: boolean; mintOpen?: boolean;
}

export interface CardFaceProps {
  card: FaceCard;
  revealed: boolean;
  picked: number | null;
  onPick?: ((i: number) => void) | null;
  onQuestion?: ((card: FaceCard) => void) | null;
}

export default function CardFace({ card, revealed, picked, onPick, onQuestion }: CardFaceProps) {
  return (<>
    <div className={"q" + (card.mintOpen ? " openq" : "")} onClick={onQuestion ? () => onQuestion(card) : undefined}>
      <MathText text={tex(cardPrompt(card))} />
    </div>
    {card.type === "mcq" ? (
      <div className="opts">
        {(card.options || []).map((o, i) => {
          let cls = "opt";
          if (picked !== null) { if (i === card.correct) cls += " correct"; else if (i === picked) cls += " wrong"; }
          return <div key={i} className={cls} onClick={() => { if (picked === null && onPick) onPick(i); }}>
            <span className="l">{i + 1}</span><span><MathText text={tex(o)} /></span></div>;
        })}
      </div>
    ) : null}
    {card.type === "mcq" && picked !== null ? <div className="a">{mdBlocks(card.explanation || "")}</div> : null}
    {card.type === "flashcard" && revealed ? <div className="a">{mdBlocks(card.back || "")}</div> : null}
    {card.type === "trick" && revealed ? <>
      <div className="a" style={{ paddingTop: 16 }}><strong><MathText text={tex(card.title || "")} /></strong></div>
      {card.cue ? <div className="blk"><span className="lbl">when you see</span><div className="b"><MathText text={tex(card.cue)} /></div></div> : null}
      {card.trick ? <div className="blk"><span className="lbl">the move</span><div className="b"><MathText text={tex(card.trick)} /></div></div> : null}
      {card.trap ? <div className="blk"><span className="lbl">trap</span><div className="b"><MathText text={tex(card.trap)} /></div></div> : null}
      {card.solution ? <div className="blk"><span className="lbl">full solution</span><div className="b">{mdBlocks(card.solution)}</div></div> : null}
    </> : null}
  </>);
}
