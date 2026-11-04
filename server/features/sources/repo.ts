import { stmt } from "../../platform/db/sql.ts";
import type { SectionRow, ResourceRow, ResourceNameRow } from "../../platform/db/rows.ts";

export const sourcesRepo = {
  // Never `*` on resources: these run on every board action and must stay clear of the bytes.
  resourcesOf: stmt<ResourceRow>("SELECT id,board_id,filename,mime,text,tokens,included,created_at,kind,origin_url,bytes_len,done_at FROM resources WHERE board_id = ? ORDER BY created_at ASC"),
  resourceSummariesOf: stmt<ResourceRow>(`SELECT id,board_id,filename,mime,
    CASE WHEN tokens>0 THEN NULL ELSE text END AS text,tokens,included,created_at,kind,origin_url,bytes_len,done_at,generation
    FROM resources WHERE board_id=? ORDER BY created_at ASC`),
  resource: stmt<ResourceRow>("SELECT id,board_id,filename,mime,text,tokens,included,created_at,kind,origin_url,bytes_len,done_at,generation FROM resources WHERE board_id = ? AND id = ?"),
  resourceNamesOf: stmt<ResourceNameRow>("SELECT id,filename,mime,kind FROM resources WHERE board_id = ? ORDER BY created_at ASC"),
  // A cover needs a few lines, including for old sources stored as bytes. Never return the file.
  resourcePreview: stmt<{ text: string | null }>(`SELECT CASE
    WHEN COALESCE(r.kind,CASE WHEN r.mime LIKE '%pdf%' OR lower(r.filename) LIKE '%.pdf' THEN 'pdf' ELSE 'text' END)='pdf' THEN NULL
    ELSE COALESCE(substr(r.text,1,2048),CAST((SELECT substr(bytes,1,2048) FROM resource_blobs WHERE resource_id=r.id) AS TEXT))
    END AS text FROM resources r WHERE r.board_id=? AND r.id=?`),
  insResource: stmt("INSERT INTO resources (id,board_id,filename,mime,text,tokens,included,created_at,kind,origin_url,bytes_len) VALUES (?,?,?,?,?,?,1,?,?,?,?)"),
  reviseResource: stmt("UPDATE resources SET mime = ?, text = ?, tokens = ?, kind = ?, bytes_len = ?, generation = generation + 1 WHERE board_id = ? AND id = ?"),
  sourceOfRef: stmt<{ resource_id: string; kind: string | null; sha256: string | null }>(`SELECT i.resource_id, r.kind, i.sha256 FROM imports i JOIN resources r ON r.id = i.resource_id AND r.board_id = i.board_id
    WHERE i.board_id = ? AND i.origin_ref = ? AND i.stage = 'imported' AND i.id <> ? ORDER BY i.created_at DESC LIMIT 1`),
  // A source's import row describes its current bytes, so a revision retires the rows before it.
  dropImportsOf: stmt("DELETE FROM imports WHERE resource_id = ?"),
  newerRevision: stmt<{ one: number }>("SELECT 1 AS one FROM imports WHERE resource_id = ? AND created_at > (SELECT created_at FROM imports WHERE id = ?)"),
  dropStaleRevision: stmt("UPDATE imports SET stage = 'cancelled', error = ?, prepared = NULL, plan = NULL, updated_at = ? WHERE id = ? AND stage = 'finalizing'"),
  dropImportChunks: stmt("DELETE FROM import_chunks WHERE import_id = ?"),
  moveResource: stmt("UPDATE resources SET board_id = ? WHERE board_id = ? AND id = ?"),

  setResourceIncluded: stmt("UPDATE resources SET included = ? WHERE board_id = ? AND id = ?"),
  setResourceName: stmt("UPDATE resources SET filename = ? WHERE board_id = ? AND id = ?"),
  setResourceDone: stmt("UPDATE resources SET done_at = ? WHERE board_id = ? AND id = ?"),
  // The `= <old>` guard leaves a name you chose yourself alone.
  renameCopiedPairLabels: stmt("UPDATE pairs SET label = ? WHERE board_id = ? AND resource_id = ? AND label = ?"),
  renameCopiedSectionLabels: stmt("UPDATE sections SET label = ? WHERE resource_id = ? AND label = ?"),
  renameSolePair: stmt(`UPDATE pairs SET label = ? WHERE board_id = ? AND resource_id = ?
    AND (SELECT COUNT(*) FROM pairs WHERE board_id = ? AND resource_id = ?) = 1`),
  delResource: stmt("DELETE FROM resources WHERE board_id = ? AND id = ?"),
  delBoardResources: stmt("DELETE FROM resources WHERE board_id = ?"),
  liveKindOf: stmt<Pick<ResourceRow, "kind" | "mime" | "filename" | "bytes_len">>("SELECT kind,mime,filename,bytes_len FROM resources WHERE board_id = ? AND id = ?"),
  pageState: stmt<{ value: string; rev: number }>("SELECT value,rev FROM page_states WHERE resource_id = ?"),
  setPageState: stmt("INSERT INTO page_states (resource_id, board_id, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(resource_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"),
  delPageState: stmt("DELETE FROM page_states WHERE resource_id = ?"),
  delBoardPageStates: stmt("DELETE FROM page_states WHERE board_id = ?"),
  insBlob: stmt("INSERT OR REPLACE INTO resource_blobs (resource_id, bytes, page_text) VALUES (?,?,?)"),
  blobOf: stmt<{ bytes: Uint8Array | null }>("SELECT bytes FROM resource_blobs WHERE resource_id = ?"),
  // substr() on a blob reads only the overflow pages it needs, so one page of a big book costs a page.
  blobSlice: stmt<{ chunk: Uint8Array | null }>("SELECT substr(bytes, ?, ?) AS chunk FROM resource_blobs WHERE resource_id = ?"),
  pageTextOf: stmt<{ page_text: string | null }>("SELECT page_text FROM resource_blobs WHERE resource_id = ?"),
  pdfsWithoutText: stmt<{ id: string }>("SELECT r.id FROM resources r JOIN resource_blobs b ON b.resource_id = r.id WHERE (r.kind = 'pdf' OR (r.kind IS NULL AND (r.mime LIKE '%pdf%' OR lower(r.filename) LIKE '%.pdf'))) AND (b.page_text IS NULL OR b.page_text IN ('', '[]', 'null')) AND b.bytes IS NOT NULL"),
  // what a PDF with no text holds: read only when it has none, so its page text is short or absent
  blobState: stmt<{ file: number; text: string | null }>("SELECT bytes IS NOT NULL AS file, substr(page_text, 1, 40) AS text FROM resource_blobs WHERE resource_id = ?"),
  setPageText: stmt("UPDATE resource_blobs SET page_text = ? WHERE resource_id = ? AND (page_text IS NULL OR page_text IN ('', '[]', 'null'))"),
  delBlob: stmt("DELETE FROM resource_blobs WHERE resource_id = ?"),
  blobExists: stmt<{ one: number }>("SELECT 1 AS one FROM resource_blobs WHERE resource_id = ?"),
  delBoardBlobs: stmt("DELETE FROM resource_blobs WHERE resource_id IN (SELECT id FROM resources WHERE board_id = ?)"),
  sectionsOf: stmt<SectionRow>("SELECT id,resource_id,board_id,ord,label,first_page,last_page,kind,tokens,content_ranges FROM sections WHERE resource_id = ? ORDER BY ord ASC"),
  sectionsOfBoard: stmt<SectionRow>("SELECT id,resource_id,board_id,ord,label,first_page,last_page,kind,tokens,content_ranges FROM sections WHERE board_id = ? ORDER BY resource_id, ord ASC"),
  section: stmt<SectionRow>("SELECT id,resource_id,board_id,ord,label,first_page,last_page,kind,tokens,content_ranges FROM sections WHERE id = ?"),
  setSectionRanges: stmt("UPDATE sections SET content_ranges = ?, kind = 'work' WHERE id = ?"),
  // kind null keeps the one it had: an unchanged section keeps its classification.
  reshapeSection: stmt("UPDATE sections SET ord = ?, label = ?, first_page = ?, last_page = ?, content_ranges = ?, tokens = ?, kind = COALESCE(?, kind) WHERE id = ?"),
  delSection: stmt("DELETE FROM sections WHERE id = ?"),
  splitRev: stmt<{ rev: number }>("SELECT COALESCE(MAX(rev), 0) rev FROM sections WHERE resource_id = ?"),
  outlineOf: stmt<{ outline: string | null }>("SELECT outline FROM resource_blobs WHERE resource_id = ?"),
  setOutline: stmt("UPDATE resource_blobs SET outline = ? WHERE resource_id = ?"),
  setSectionKind: stmt("UPDATE sections SET kind = ? WHERE id = ?"),
  insSection: stmt("INSERT INTO sections (id,resource_id,board_id,ord,label,first_page,last_page,created_at,tokens) VALUES (?,?,?,?,?,?,?,?,?)"),
  delSectionsOf: stmt("DELETE FROM sections WHERE resource_id = ?"),
  delBoardSections: stmt("DELETE FROM sections WHERE board_id = ?"),
};
