import type { MouseEvent } from "react";
import { starProject } from "../../data/entities/plan.ts";
import { StrataWhy } from "../../data/api.ts";
import { toast } from "../../shell/layers.ts";
import "./project-star.css";

/** ☆/★ on a project: starred projects sort first on Today and Projects. */
export default function ProjectStar({ board, name, starred, className }: { board: string; name: string; starred: boolean; className?: string }) {
  const flip = (e: MouseEvent) => {
    e.stopPropagation();
    starProject(board, !starred).catch((x: unknown) => toast(StrataWhy(x, starred ? "couldn't unstar that" : "couldn't star that")));
  };
  return <button type="button" className={"pj-star" + (starred ? " on" : "") + (className ? " " + className : "")} aria-pressed={starred}
    aria-label={(starred ? "Unstar " : "Star ") + name} title={starred ? "Starred: sorts first. Click to unstar" : "Star: sort it first"}
    onClick={flip}>{starred ? "★" : "☆"}</button>;
}
