import type { MouseEvent } from "react";
import { StrataWhy } from "../../data/api.ts";
import { plan } from "../../data/entities/plan.ts";
import { toast } from "../../shell/layers.ts";
import "./star-project.css";

export interface StarProjectProps { board: string; title: string; starred: boolean; className?: string }

/** ☆/★ on a project wherever it is listed: starred projects sort first on Today and Projects. */
export default function StarProject({ board, title, starred, className }: StarProjectProps) {
  const flip = (e: MouseEvent) => {
    e.stopPropagation();
    plan.star(board, !starred).catch((x: unknown) => toast(StrataWhy(x, starred ? "couldn't unstar that" : "couldn't star that"), 4200));
  };
  return <button className={"star-project" + (starred ? " on" : "") + (className ? " " + className : "")} aria-pressed={starred}
    aria-label={(starred ? "Unstar " : "Star ") + title} title={starred ? "Starred: sorts first. Click to unstar" : "Star: sort it first"}
    onClick={flip} onDoubleClick={(e) => e.stopPropagation()}>{starred ? "★" : "☆"}</button>;
}
