import type { ReactNode } from "react";
import { TOUCH } from "../../platform/device.js";

export interface CardAction {
  id: string; label: ReactNode; kbd?: string; on: () => void;
  live?: boolean; title?: string; arm?: boolean;
}
export interface CardHint { id: string; text: ReactNode; kbd?: string; live?: boolean }
type Maybe<T> = T | null | undefined | false;

export interface CardControlsProps {
  actions?: Maybe<CardAction>[];
  hints?: Maybe<CardHint>[];
  className?: string;
}

function CardControls({ actions, hints, className }: CardControlsProps) {
  const acts = (actions || []).filter(Boolean) as CardAction[];
  const says = (hints || []).filter(Boolean) as CardHint[];
  if (!acts.length && !says.length) return null;
  return (
    <div className={"keys" + (className ? " " + className : "")}>
      {acts.map((a) => (
        <button key={a.id} type="button" className={"tk" + (a.live ? " live" : "") + (a.arm ? " arm" : "")}
          title={a.title} onClick={a.on} onMouseDown={(e) => e.preventDefault()}>
          {!TOUCH && a.kbd ? <kbd>{a.kbd}</kbd> : null}
          {a.label}
        </button>
      ))}
      {says.map((h) => (
        <span key={h.id} className={h.live ? "live" : undefined}>
          {!TOUCH && h.kbd ? <kbd>{h.kbd}</kbd> : null}
          {h.text}
        </span>
      ))}
    </div>
  );
}

export const gradeActions = (onGrade: (got: boolean) => void): CardAction[] => [
  { id: "missed", label: "missed", kbd: "1", on: () => onGrade(false) },
  { id: "got", label: "got it", kbd: "2", on: () => onGrade(true) },
];

export default CardControls;
