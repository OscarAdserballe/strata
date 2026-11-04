import { bucketByDay } from "./kept.ts";
import CardIcon from "../../shell/CardIcon.tsx";

// one formatter each: toLocaleDateString builds a new one on every call
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayLabel = (i: number, days: number, now: number, compact = false) => {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1 - i));
  return (compact ? WEEKDAY : DAY_MONTH).format(d).toLowerCase();
};

export interface KeptChartProps {
  times: number[] | null | undefined;
  days?: number;
  compact?: boolean;
  label?: string;
  now?: number;
}

function KeptChart({ times, days = 14, compact = false, label = "kept", now = Date.now() }: KeptChartProps) {
  const n = bucketByDay(times, days, now);
  const max = Math.max(1, ...n);
  const week = n.slice(-7).reduce((a, b) => a + b, 0);
  const total = n.reduce((a, b) => a + b, 0);
  const todayN = n[n.length - 1];
  return (
    <div className="kc" role="img"
      aria-label={`cards kept over the last ${days} days: ${total}, ${week} of them this week, ${todayN} today`}>
      <div className="kc-head">
        <span className="dk-ov">{label} · last {days} days</span>
        <span className="kc-sum">
          {compact ? <b><CardIcon /> {total}</b> : week ? <><b><CardIcon /> {week}</b> this week</> : total ? <>none this week · {total} before</> : <>nothing kept yet</>}
        </span>
      </div>
      <div className="kc-bars">
        {n.map((v, i) => (
          <span key={i} data-n={v} title={`${dayLabel(i, days, now)}: ${v} card${v === 1 ? "" : "s"} kept`}
            className={"kc-col" + (i === n.length - 1 ? " today" : "") + (v ? "" : " zero") + (v && v === max && n.indexOf(max) === i ? " peak" : "")}>
            <i style={{ height: v ? Math.max(8, Math.round((100 * v) / max)) + "%" : "4px" }} />
            {compact ? <b>{i === n.length - 1 ? "today" : dayLabel(i, days, now, true)}</b> : i === 0 ? <b>{dayLabel(i, days, now)}</b> : i === n.length - 1 ? <b>today</b> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

export default KeptChart;
