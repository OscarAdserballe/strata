import { stmt } from "../../platform/db/sql.ts";

export interface TokenRow { id: string; name: string; scopes: string; created_at: number; last_used_at: number | null; revoked_at: number | null }
export interface KeptRow { id: string; course: string; created_at: number; type: string; payload: string }
export interface SourceRow { id: string; filename: string | null; kind: string | null; origin_url: string | null; created_at: number; done_at: number | null; tokens: number | null; bytes_len: number | null }
export interface ChatRow { resource_id: string | null; words?: string | null; course: string | null; card: string | null; role: string; text: string; created_at: number; archived: number }
export interface GradeRow { card: string; course: string; got: number; at: number }
export interface AgentImportRow {
  id: string; board_id: string; filename: string; size: number; received: number; stage: string; error: string | null;
  resource_id: string | null; sha256: string | null; origin: string | null; origin_ref: string | null; auto: number; created_at: number;
}

// A board's decks are the decks its pairs open; every per-board card read goes through this set.
const DECKS = "SELECT deck FROM pairs WHERE board_id = ? AND deck IS NOT NULL";

// the words a turn was asked at, by the asks primary key
const WORDS = "(SELECT quote FROM asks a WHERE a.board_id = m.board_id AND a.id = m.ask_id)";
export const agentRepo = {
  tokens: stmt<TokenRow>("SELECT id,name,scopes,created_at,last_used_at,revoked_at FROM agent_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC"),
  tokenByHash: stmt<TokenRow>("SELECT id,name,scopes,created_at,last_used_at,revoked_at FROM agent_tokens WHERE hash = ? AND revoked_at IS NULL"),
  insToken: stmt("INSERT INTO agent_tokens (id,name,hash,scopes,created_at) VALUES (?,?,?,?,?)"),
  touchToken: stmt("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?"),
  setting: stmt<{ value: string }>("SELECT value FROM settings WHERE key = ?"),
  revokeToken: stmt("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),

  boardsAll: stmt<{ id: string; title: string; type: string | null; handle: string | null; purpose: string | null; touched_at: number | null; created_at: number }>(
    "SELECT id,title,type,handle,purpose,touched_at,created_at FROM boards WHERE type IS NULL OR type != 'eval' ORDER BY COALESCE(touched_at, created_at) DESC"),
  boardByHandle: stmt<{ id: string }>("SELECT id FROM boards WHERE handle = ?"),
  boardMeta: stmt<{ id: string; title: string; handle: string | null; purpose: string | null; created_at: number; touched_at: number | null }>(
    "SELECT id,title,handle,purpose,created_at,touched_at FROM boards WHERE id = ?"),
  setHandle: stmt("UPDATE boards SET handle = ? WHERE id = ?"),
  sourcesOf: stmt<SourceRow>("SELECT id,filename,kind,origin_url,created_at,done_at,tokens,bytes_len FROM resources WHERE board_id = ? ORDER BY created_at ASC"),
  sourceOne: stmt<SourceRow & { board_id: string }>("SELECT id,board_id,filename,kind,origin_url,created_at,done_at,tokens,bytes_len FROM resources WHERE id = ?"),
  sourceText: stmt<{ text: string | null }>("SELECT text FROM resources WHERE id = ?"),
  unstudied: stmt<{ one: number }>("SELECT 1 AS one FROM trees WHERE resource_id = ? AND status = 'unstudied' LIMIT 1"),
  sourceCounts: stmt<{ n: number; done: number }>("SELECT COUNT(*) n, COUNT(done_at) done FROM resources WHERE board_id = ?"),
  notesMeta: stmt<{ text: string; updated_at: number }>("SELECT text,updated_at FROM board_notes WHERE board_id = ?"),

  decksOf: stmt<{ deck: string; resource_id: string | null; section_id: string | null; label: string | null }>(
    "SELECT deck,resource_id,section_id,label FROM pairs WHERE board_id = ? AND deck IS NOT NULL ORDER BY ord ASC"),
  cardsOfBoard: stmt<{ id: string; course: string; type: string; payload: string }>(
    `SELECT id,course,type,payload FROM cards WHERE course IN (${DECKS}) ORDER BY course, ord`),
  // A cheap superset for search: SQLite's lower() folds ASCII only, so callers use it for ASCII needles.
  cardsMatching: stmt<{ id: string; course: string; type: string; payload: string }>(
    `SELECT id,course,type,payload FROM cards WHERE course IN (${DECKS}) AND instr(lower(payload), ?) > 0 LIMIT ?`),
  keptMatching: stmt<KeptRow>(`SELECT k.id,k.course,k.created_at,c.type,c.payload FROM card_keeps k JOIN cards c ON c.id = k.id
    WHERE k.course IN (${DECKS}) AND instr(lower(c.payload), ?) > 0 LIMIT ?`),
  keptOfBoard: stmt<KeptRow>(`SELECT k.id,k.course,k.created_at,c.type,c.payload FROM card_keeps k JOIN cards c ON c.id = k.id
    WHERE k.course IN (${DECKS}) ORDER BY k.created_at DESC`),
  keptCount: stmt<{ n: number }>(`SELECT COUNT(*) n FROM card_keeps k JOIN cards c ON c.id = k.id WHERE k.course IN (${DECKS})`),
  keptCountsByCourse: stmt<{ course: string; n: number }>(`SELECT k.course, COUNT(*) n FROM card_keeps k JOIN cards c ON c.id = k.id
    WHERE k.course IN (${DECKS}) GROUP BY k.course`),
  cardCountsByCourse: stmt<{ course: string; n: number }>(`SELECT course, COUNT(*) n FROM cards WHERE course IN (${DECKS}) GROUP BY course`),
  cardById: stmt<{ id: string; course: string; deck: string; type: string; payload: string }>("SELECT id,course,deck,type,payload FROM cards WHERE id = ?"),
  keptAt: stmt<{ created_at: number }>("SELECT created_at FROM card_keeps WHERE id = ?"),
  deckBoard: stmt<{ board_id: string; resource_id: string | null; section_id: string | null }>(
    "SELECT board_id,resource_id,section_id FROM pairs WHERE deck = ? ORDER BY rowid ASC LIMIT 1"),

  gradesOfBoard: stmt<GradeRow>(`SELECT card,course,got,at FROM review_receipts WHERE course IN (${DECKS}) AND at >= ? ORDER BY at DESC LIMIT ?`),
  gradesOfCard: stmt<{ got: number; at: number }>("SELECT got,at FROM review_receipts WHERE card = ? ORDER BY at DESC LIMIT 10"),
  keptSince: stmt<KeptRow>(`SELECT k.id,k.course,k.created_at,c.type,c.payload FROM card_keeps k JOIN cards c ON c.id = k.id
    WHERE k.course IN (${DECKS}) AND k.created_at >= ? ORDER BY k.created_at DESC LIMIT ?`),
  marksSince: stmt<{ id: string; resource_id: string; quote: string; note: string | null; updated_at: number }>(
    "SELECT id,resource_id,quote,note,updated_at FROM marks WHERE board_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?"),
  mintedSince: stmt<{ id: string; state: string; front: string; created_at: number; updated_at: number }>(
    "SELECT id,state,front,created_at,updated_at FROM minted WHERE board_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?"),
  resourcesSince: stmt<{ id: string; filename: string | null; created_at: number; done_at: number | null }>(
    "SELECT id,filename,created_at,done_at FROM resources WHERE board_id = ? AND (created_at >= ? OR done_at >= ?) ORDER BY created_at DESC LIMIT ?"),

  marksFull: stmt<{ id: string; resource_id: string; page: number | null; quote: string; note: string | null; box: string | null; created_at: number; updated_at: number }>(
    "SELECT id,resource_id,page,quote,note,box,created_at,updated_at FROM marks WHERE board_id = ? ORDER BY resource_id, page, start_off"),
  mintedFull: stmt<{ id: string; pair_id: string | null; state: string; front: string; back: string | null; source: string | null; created_at: number; updated_at: number }>(
    "SELECT id,pair_id,state,front,back,source,created_at,updated_at FROM minted WHERE board_id = ? ORDER BY created_at ASC"),
  mintedOne: stmt<{ id: string; pair_id: string | null; state: string; front: string; back: string | null; source: string | null; created_at: number; updated_at: number }>(
    "SELECT id,pair_id,state,front,back,source,created_at,updated_at FROM minted WHERE board_id = ? AND id = ?"),
  mintedBoard: stmt<{ board_id: string }>("SELECT board_id FROM minted WHERE id = ?"),
  resourceBoard: stmt<{ board_id: string }>("SELECT board_id FROM resources WHERE id = ?"),
  pageStateOf: stmt<{ value: string; updated_at: number }>("SELECT value,updated_at FROM page_states WHERE resource_id = ?"),
  markBoard: stmt<{ board_id: string }>("SELECT board_id FROM marks WHERE id = ?"),
  // drafts are the reader's until Send back, so an agent reads only what was sent
  generationOf: stmt<{ generation: number | null }>("SELECT generation FROM resources WHERE id = ?"),
  groupBoard: stmt<{ board_id: string }>("SELECT board_id FROM board_groups WHERE id = ?"),
  milestoneBoard: stmt<{ board_id: string }>("SELECT board_id FROM board_milestones WHERE id = ?"),

  chatOf: stmt<ChatRow>(`SELECT resource_id, ${WORDS} words, NULL course, NULL card, role, COALESCE(text, '') text, created_at, archived FROM messages m WHERE board_id = ?
    UNION ALL SELECT NULL, NULL, course, card, role, text, created_at, archived FROM card_messages WHERE course IN (${DECKS}) ORDER BY created_at DESC`),
  chatCount: stmt<{ n: number; cleared: number }>(`SELECT COUNT(*) n, COALESCE(SUM(archived), 0) cleared FROM (
    SELECT archived FROM messages WHERE board_id = ? UNION ALL SELECT archived FROM card_messages WHERE course IN (${DECKS}))`),
  // The same ASCII-only superset as cardsMatching.
  chatMatching: stmt<ChatRow>(`SELECT resource_id, ${WORDS} words, NULL course, NULL card, role, COALESCE(text, '') text, created_at, archived FROM messages m WHERE board_id = ? AND instr(lower(text), ?) > 0
    UNION ALL SELECT NULL, NULL, course, card, role, text, created_at, archived FROM card_messages WHERE course IN (${DECKS}) AND instr(lower(text), ?) > 0
    ORDER BY created_at DESC LIMIT ?`),

  importOne: stmt<AgentImportRow>("SELECT id,board_id,filename,size,received,stage,error,resource_id,sha256,origin,origin_ref,auto,created_at FROM imports WHERE id = ?"),
  importBySha: stmt<AgentImportRow>(`SELECT id,board_id,filename,size,received,stage,error,resource_id,sha256,origin,origin_ref,auto,created_at
    FROM imports WHERE board_id = ? AND sha256 = ? AND stage NOT IN ('cancelled','error') ORDER BY created_at DESC LIMIT 1`),
  importByRef: stmt<{ id: string }>("SELECT id FROM imports WHERE board_id = ? AND origin_ref = ? AND stage <> 'cancelled' LIMIT 1"),
  importOfResource: stmt<{ origin: string | null; origin_ref: string | null }>("SELECT origin,origin_ref FROM imports WHERE resource_id = ?"),
  setImportOrigin: stmt("UPDATE imports SET auto = 1, origin = ?, origin_ref = ?, sha256 = ?, study = ? WHERE id = ?"),
};
