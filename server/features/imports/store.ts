import type { DatabaseSync } from 'node:sqlite';
import type { ImportStage, ImportStatus } from '../../../shared/imports/import-status.ts';
import { httpError } from '../../platform/http/http.ts';
import { transaction } from '../../platform/db/transaction.ts';

export interface ImportRow extends ImportStatus {
  prepared: string | null; plan: string | null; attempts: number; created_at: number; study: number; origin_ref: string | null;
}

export function importStore(db: DatabaseSync) {
  const get = (id: string) => db.prepare('SELECT * FROM imports WHERE id=?').get(id) as unknown as ImportRow | undefined;
  const transition = (id: string, from: ImportStage, to: ImportStage, error: string | null = null) =>
    db.prepare('UPDATE imports SET stage=?,error=?,updated_at=? WHERE id=? AND stage=?').run(to,error,Date.now(),id,from).changes > 0;
  return {
    get, transition,
    create(id: string, board: string, filename: string, size: number, study = true): ImportRow {
      const old = get(id);
      if (old) {
        if (old.board_id !== board || old.filename !== filename || old.size !== size) throw httpError(409,'This import ID belongs to a different file.');
        return old;
      }
      const at = Date.now();
      db.prepare('INSERT INTO imports(id,board_id,filename,size,study,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,board,filename,size,study ? 1 : 0,at,at);
      return get(id)!;
    },
    chunk(id: string, offset: number, bytes: Buffer): ImportRow {
      transaction(db, () => {
        const row = get(id);
        if (!row) throw httpError(404,'Import not found.');
        if (row.stage !== 'uploading') throw httpError(409,'This upload has already finished.');
        if (!Number.isSafeInteger(offset) || offset < 0 || !bytes.length || offset + bytes.length > row.size) throw httpError(400,'Invalid upload chunk.');
        if (offset < row.received) {
          const old = db.prepare('SELECT bytes FROM import_chunks WHERE import_id=? AND offset=?').get(id,offset) as {bytes: Uint8Array} | undefined;
          if (!old || !Buffer.from(old.bytes).equals(bytes)) throw httpError(409,'This chunk differs from the bytes already saved.');
        } else {
          if (offset !== row.received) throw httpError(409,'Upload offset changed. Resume from the saved offset.');
          db.prepare('INSERT INTO import_chunks VALUES(?,?,?)').run(id,offset,bytes);
          db.prepare('UPDATE imports SET received=received+?,error=NULL,updated_at=? WHERE id=?').run(bytes.length,Date.now(),id);
        }
      });
      return get(id)!;
    },
    bytes(id: string): Buffer {
      return Buffer.concat((db.prepare('SELECT bytes FROM import_chunks WHERE import_id=? ORDER BY offset').all(id) as {bytes: Uint8Array}[]).map(r => Buffer.from(r.bytes)));
    },
    recover(): void {
      db.exec("UPDATE imports SET stage='stored' WHERE stage='extracting'; UPDATE imports SET stage='queued' WHERE stage='finalizing';");
    },
  };
}
