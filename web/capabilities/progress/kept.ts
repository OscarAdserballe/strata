// bucketed by local calendar day, not 24-hour slices, so a clock change cannot shift a bar

const DAY = 864e5;

export function bucketByDay(times: number[] | null | undefined, days: number, now: number): number[] {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const start = d0.getTime() - (days - 1) * DAY;
  const out: number[] = new Array(days).fill(0);
  for (const t of times || []) {
    if (t < start) continue;
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    const i = Math.round((d.getTime() - start) / DAY);
    if (i >= 0 && i < days) out[i]++;
  }
  return out;
}
