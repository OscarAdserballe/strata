import type { DatabaseSync } from "node:sqlite";

/** Long work may commit only to the source revision and section it started with. */
export function sourceFence(db: DatabaseSync, rid: string, board: string, sid?: string): () => boolean {
  const resource = db.prepare("SELECT board_id, generation FROM resources WHERE id = ?");
  const section = db.prepare("SELECT board_id, resource_id, first_page, last_page, content_ranges FROM sections WHERE id = ?");
  const original = resource.get(rid);
  const shape = sid ? JSON.stringify(section.get(sid)) : null;
  return () => {
    const current = resource.get(rid);
    return !!original && !!current && current.board_id === board && current.generation === original.generation
      && (!sid || (shape !== undefined && shape === JSON.stringify(section.get(sid))));
  };
}
