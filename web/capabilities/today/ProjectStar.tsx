import "./project-star.css";

/** The star on a project: a starred project sorts first on Today and Projects, and the rest step back. */
export default function ProjectStar({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return <button className={"proj-star" + (on ? " on" : "")} aria-pressed={on} aria-label={on ? "Unstar project" : "Star project"}
    title={on ? "Starred: sorts first" : "Star to keep it first"} onClick={(e) => { e.stopPropagation(); onToggle(); }}>{on ? "★" : "☆"}</button>;
}
