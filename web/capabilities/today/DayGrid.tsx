import type { Days } from "./days.ts";
import "./day-grid.css";

/** 26 weeks of days, Monday at the top; the ink is minutes read and reviewed. */
export default function DayGrid({ days, big }: { days: Days; big?: boolean }) {
  return <div className={"td-grid" + (big ? " big" : "")} aria-label={`${days.total} days with Strata, ${days.streak} in a row`} role="img">
    {days.grid.map((col, w) => <div key={w} className="td-col">{col.map((v, i) => <i key={i} className={"td-ink i" + v} />)}</div>)}
  </div>;
}
