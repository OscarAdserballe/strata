import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { summarizeUsage } from './usage-summary.mjs';

export function createUsageSnapshot(collect) {
  let cached; let pending;
  return async () => {
    if (cached && Date.now() - cached.at < 60_000) return cached;
    pending ??= Promise.resolve().then(collect).then((rooms) => (cached = { at: Date.now(), rooms })).finally(() => { pending = null; });
    return pending;
  };
}

export function projectRoom(reader, data) {
  try {
    const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : 0;
    const timestamp = (v) => Number.isSafeInteger(v) && v >= 0 && v <= Date.now() + 5000 ? v : null;
    const fields = ['activeDays','browserSessions','boardsCreated','sourcesAdded','cardsGenerated','cardViews','cardsGraded','reviewAnswers','cardsKept','chatTurns','distillations','distillationErrors','meteredOperations','unmeteredOperations','recordedApiCalls','promptTokens','outputTokens','thoughtsTokens','cachedTokens'];
    const periods = Object.fromEntries(['7','30','all'].map((key) => [key, Object.fromEntries(fields.map((f) => [f, count(data.periods[key][f])]))]));
    return { reader, status: 'ok', firstEventAt: timestamp(data.firstEventAt), lastActiveAt: timestamp(data.lastActiveAt),
      inventory: Object.fromEntries(['boards','sources','cards','keptCards'].map((f) => [f, count(data.inventory[f])])), periods,
      daily: data.daily.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)).map((d) => ({ day: d.day, interactions: count(d.interactions) })) };
  } catch { return { reader, status: 'unavailable' }; }
}

// One room at a time, read-only: only aggregates leave each database.
export function collectRooms(rooms) {
  return rooms.map(({ reader, db: path }) => {
    if (!existsSync(path)) return { reader, status: 'unavailable' };
    const db = new DatabaseSync(path, { readOnly: true });
    try { return projectRoom(reader, summarizeUsage(db)); } catch { return { reader, status: 'unavailable' }; } finally { db.close(); }
  });
}
