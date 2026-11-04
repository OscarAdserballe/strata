import { stmt } from "../../platform/db/sql.ts";

export const reviewRepo = {
  cardKeptAt: stmt<{ created_at: number }>("SELECT created_at FROM card_keeps WHERE id = ?"),
  cardAddedAt: stmt<{ card_at: number | null; source_at: number | null }>(`SELECT
    (SELECT MIN(created_at) FROM minted WHERE card_id = ?) AS card_at,
    (SELECT MIN(r.created_at) FROM resources r JOIN pairs p ON p.resource_id = r.id WHERE p.deck = ?)
    AS source_at`),
  cardReviewHistory: stmt<{ ts: number; got: number }>(`SELECT ts, json_extract(props, '$.got') AS got
    FROM events WHERE event = 'card_grade' AND json_extract(props, '$.card') = ?
      AND json_extract(props, '$.review') = 1 ORDER BY ts DESC, id DESC`),
  // Unscoped by board: memory is the reader's. The cards join drops tombstoned and minted ids.
  gradeEvents: stmt<{ card: string; ts: number; got: number | null; kind: "grade" | "answer"; review: number | null }>(`SELECT
      c.id AS card, e.ts AS ts,
      COALESCE(json_extract(e.props,'$.got'), json_extract(e.props,'$.hit')) AS got,
      CASE e.event WHEN 'card_answer' THEN 'answer' ELSE 'grade' END AS kind,
      json_extract(e.props,'$.review') AS review
    FROM events e JOIN cards c ON c.id = json_extract(e.props,'$.card')
    WHERE e.event IN ('card_grade','card_answer')
    ORDER BY e.ts ASC, e.id ASC`),
  // Payloads come once from here rather than on every grade row.
  allCards: stmt<{ id: string; course: string; deck: string; type: string; payload: string; ord: number }>(
    "SELECT id, course, deck, type, payload, ord FROM cards"),
  // A schedule can outlive its card, so due cards are filtered by these ids.
  cardIds: stmt<{ id: string }>("SELECT id FROM cards"),
  // card_grade only: an MCQ's card_answer is a pick, not a verdict.
  sessionGrades: stmt<{ card: string; ts: number; got: number | null }>(`SELECT
      c.id AS card, e.ts AS ts, json_extract(e.props,'$.got') AS got
    FROM events e JOIN cards c ON c.id = json_extract(e.props,'$.card')
    WHERE e.event = 'card_grade' AND json_extract(e.props,'$.review') = 1 AND e.ts >= ?
    ORDER BY e.ts ASC, e.id ASC`),
};
