import { activity } from "../../platform/db/sql.ts";

export const progressRepo = {
  // MAX(id) with bare columns is SQLite's pick-the-max-row form.
  lastReadOf: activity<{ resource: string | null; deepest: number | null }>(
    "SELECT resource,last_depth AS deepest FROM activity_read WHERE board=? ORDER BY last_id DESC LIMIT 1"),
  readProgressOf: activity<{ resource: string | null; deepest: number | null; ms: number | null; at: number | null }>(
    "SELECT resource,deepest,ms,at FROM activity_read WHERE board=?"),
  readViewsOf: activity<{ resource: string | null; at: number | null }>("SELECT resource,at FROM activity_views WHERE board=?"),
  // DISTINCT ids so re-scrubbing never inflates past the deck size; done means answered, not correct.
  deckSeenOf: activity<{ slug: string; n: number }>("SELECT c.course slug,COUNT(*) n FROM activity_cards a JOIN cards c ON c.id=a.card WHERE a.board=? AND a.seen>0 GROUP BY c.course"),
  deckDoneOf: activity<{ slug: string; n: number }>("SELECT c.course slug,COUNT(*) n FROM activity_cards a JOIN cards c ON c.id=a.card WHERE a.board=? AND a.done>0 GROUP BY c.course"),
  seenCardsOf: activity<{ id: string }>("SELECT c.id FROM activity_cards a JOIN cards c ON c.id=a.card WHERE a.board=? AND a.seen>0"),
  doneCardsOf: activity<{ id: string }>("SELECT c.id FROM activity_cards a JOIN cards c ON c.id=a.card WHERE a.board=? AND a.done>0"),
  // MAX(a.seen) with bare columns picks the max row; joining onto cards keeps minted ids out.
  deckLastOf: activity<{ slug: string; card: string }>("SELECT c.course slug,c.id card,MAX(a.seen) FROM activity_cards a JOIN cards c ON c.id=a.card WHERE a.board=? AND a.seen>0 GROUP BY c.course"),
};
