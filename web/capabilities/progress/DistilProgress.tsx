import { useEffect, useState } from "react";

export interface DistilBusy {
  r: { id: string };
  name: string;
  phase: "preparing" | "reading" | "carding" | null;
  at: { label?: string } | null;
  done: number;
  total: number;
  updatedAt: number;
}

export default function DistilProgress({ work, compact = false }: { work: DistilBusy; compact?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { name, phase, done, total, updatedAt, at } = work;
  const seconds = Math.max(0, (now - updatedAt) / 1000);
  // The server reports stages, not token progress. Ease toward each stage's ceiling.
  const [start, ceiling] = phase === "carding" ? [65, 95]
    : phase === "reading" ? [20, 60] : phase === "preparing" ? [3, 18] : [18, 18];
  const section = start + (ceiling - start) * (1 - Math.exp(-seconds / 65));
  const percent = Math.min(99, Math.floor((done * 100 + section) / Math.max(1, total)));
  const label = phase === "carding" ? "Making cards. Tiny paper factory."
    : phase === "reading" ? "Reading it. Connecting the dots."
    : phase === "preparing" ? "Source landed. Warming up the card factory."
    : "In line. The card factory is busy.";

  return (
    <div className={"card-progress" + (compact ? " compact" : "")}>
      <div className="card-progress-head">
        <span className="card-progress-stack" aria-hidden="true"><i /><i /><i /></span>
        <div className="card-progress-copy">
          <div className="card-progress-name">{name}</div>
          <div className="card-progress-label" role="status">{label}</div>
        </div>
      </div>
      <div className="card-progress-track" role="progressbar" aria-label={`Making cards for ${name} (estimated)`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`About ${percent} percent. ${label}`}>
        <div className="card-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="card-progress-meta">
        <span>{total > 1 ? `${done} of ${total} sections ready` : "You can keep reading — we’ll put them here."}</span>
        <span>~{percent}%</span>
      </div>
      <div className="card-progress-note">
        {total > 1 && at ? `${at.label} · ` : ""}Estimated progress · keeps going if you leave.
      </div>
    </div>
  );
}
