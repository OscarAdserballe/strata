// Only aggregates leave SQLite.
const INTERACTIONS = "'board_create','board_enter','card_show','card_reveal','card_grade','card_answer','card_keep','card_unkeep','chat_turn','review_chat','resource_add','mark_add','mark_note','notes_write','read_progress','review_start'";
const AI_EVENTS = "'chat_turn','review_chat','distil_done','distil_error','source_tree_done'";
const numeric = (key) => `CASE WHEN json_type(p,'$.${key}') IN ('integer','real') AND json_extract(p,'$.${key}') >= 0 THEN CAST(json_extract(p,'$.${key}') AS INTEGER) ELSE 0 END`;
// Read only the counted events, through the event index: parsing every row as JSON is too slow.
const COUNTED = `${INTERACTIONS},${AI_EVENTS}`;
const events = `WITH e AS (SELECT ts,event,session,CASE WHEN json_valid(props) THEN props ELSE '{}' END p FROM events WHERE event IN (${COUNTED}))`;

export function summarizeUsage(db, at = Date.now()) {
  db.exec("BEGIN");
  try {
    const coverage = db.prepare(`SELECT (SELECT MIN(ts) FROM events WHERE ts <= ?) firstEventAt,
      (SELECT MAX(ts) FROM events WHERE event IN (${INTERACTIONS}) AND ts <= ?) lastActiveAt`).get(at, at);
    const inventory = db.prepare(`SELECT (SELECT COUNT(*) FROM boards) boards, (SELECT COUNT(*) FROM resources) sources,
      (SELECT COUNT(*) FROM cards) cards, (SELECT COUNT(*) FROM card_keeps) keptCards`).get();
    const periods = {};
    for (const days of [7, 30, 0]) {
      const from = days ? at - days * 864e5 : 0;
      periods[days || 'all'] = db.prepare(`${events} SELECT
        COUNT(DISTINCT CASE WHEN event IN (${INTERACTIONS}) THEN date(ts/1000,'unixepoch') END) activeDays,
        COUNT(DISTINCT CASE WHEN event IN (${INTERACTIONS}) THEN NULLIF(session,'') END) browserSessions,
        COUNT(CASE WHEN event='board_create' THEN 1 END) boardsCreated,
        COUNT(CASE WHEN event='resource_add' THEN 1 END) sourcesAdded,
        COALESCE(SUM(CASE WHEN event='distil_done' THEN ${numeric('cards')} ELSE 0 END),0) cardsGenerated,
        COUNT(CASE WHEN event='card_show' THEN 1 END) cardViews,
        COUNT(CASE WHEN event='card_grade' THEN 1 END) cardsGraded,
        COUNT(CASE WHEN event='card_grade' AND json_extract(p,'$.review')=1 THEN 1 END) reviewAnswers,
        COUNT(CASE WHEN event='card_keep' THEN 1 END) cardsKept,
        COUNT(CASE WHEN event IN ('chat_turn','review_chat') THEN 1 END) chatTurns,
        COUNT(CASE WHEN event='distil_done' THEN 1 END) distillations,
        COUNT(CASE WHEN event='distil_error' THEN 1 END) distillationErrors,
        COUNT(CASE WHEN event IN (${AI_EVENTS}) AND json_type(p,'$.promptTokens') IN ('integer','real') THEN 1 END) meteredOperations,
        COUNT(CASE WHEN event IN (${AI_EVENTS}) AND COALESCE(json_type(p,'$.promptTokens'),'null') NOT IN ('integer','real') THEN 1 END) unmeteredOperations,
        COALESCE(SUM(CASE WHEN event IN ('chat_turn','review_chat') AND json_type(p,'$.promptTokens') IN ('integer','real') THEN 1
          WHEN event IN ('distil_done','distil_error','source_tree_done') THEN ${numeric('calls')} ELSE 0 END),0) recordedApiCalls,
        ${['promptTokens','outputTokens','thoughtsTokens','cachedTokens'].map((key) => `COALESCE(SUM(CASE WHEN event IN (${AI_EVENTS}) THEN ${numeric(key)} ELSE 0 END),0) ${key}`).join(',')}
        FROM e WHERE ts >= ? AND ts <= ?`).get(from, at);
    }
    const daily = db.prepare(`SELECT date(ts/1000,'unixepoch') day, COUNT(*) interactions FROM events
      WHERE ts >= ? AND ts <= ? AND event IN (${INTERACTIONS}) GROUP BY day ORDER BY day`).all(at - 30 * 864e5, at);
    return { ...coverage, inventory, periods, daily };
  } finally { db.exec("ROLLBACK"); }
}
