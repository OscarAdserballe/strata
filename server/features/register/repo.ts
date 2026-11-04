import { stmt, activity } from "../../platform/db/sql.ts";
import type { ResourceRow } from "../../platform/db/rows.ts";

export const registerRepo = {
  // Pin the covering index: without fresh ANALYZE stats SQLite picks the id index and visits large rows.
  allResources: stmt<ResourceRow & { board_title: string; board_type: string | null }>(
    `SELECT r.id,r.board_id,r.filename,r.mime,NULL AS text,r.tokens,r.included,r.created_at,r.kind,
            r.origin_url,r.bytes_len,r.done_at, b.title AS board_title, b.type AS board_type
     FROM resources r INDEXED BY resources_metadata JOIN boards b ON b.id = r.board_id
     WHERE b.type IS NULL OR b.type != 'eval'
     ORDER BY r.created_at ASC, r.id ASC`),
  readProgressAll: activity<{ resource: string | null; deepest: number | null; ms: number | null; at: number | null }>(
    "SELECT resource,MAX(deepest) deepest,SUM(ms) ms,MAX(at) at FROM activity_read GROUP BY resource"),
  readViewsAll: activity<{ resource: string | null; at: number | null }>(
    "SELECT resource,MAX(at) at FROM activity_views GROUP BY resource"),
  treeStateAll: stmt<{ resource_id: string; busy: number; failed: number }>(
    `SELECT resource_id,
       SUM(CASE WHEN status IN ('preparing','queued','running','carding') THEN 1 ELSE 0 END) AS busy,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed
     FROM trees GROUP BY resource_id`),
  pairDecksAll: stmt<{ board_id: string; id: string; resource_id: string; deck: string }>(
    `SELECT board_id,id,resource_id,deck FROM pairs WHERE resource_id IS NOT NULL AND deck IS NOT NULL`),
  pairsAll: stmt<{ board_id: string; id: string; resource_id: string | null }>(
    `SELECT board_id,id,resource_id FROM pairs WHERE resource_id IS NOT NULL`),
  deckSeenAll: activity<{ slug: string; n: number }>(
    "SELECT c.course slug,COUNT(DISTINCT c.id) n FROM activity_cards a JOIN cards c ON c.id=a.card WHERE a.seen>0 GROUP BY c.course"),
  keptSince: stmt<{ course: string; created_at: number }>("SELECT course, created_at FROM card_keeps WHERE created_at >= ? ORDER BY created_at ASC"),
};
