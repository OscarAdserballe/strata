export interface MsgRow { role: string; text: string; idx: number; resource_id: string | null; ask_id?: string | null }
export interface AskRow { id: string; resource_id: string; page: number | null; start_off: number; end_off: number; quote: string; rects: string | null; box: string | null; created_at: number }
export interface PairRow { id: string; label: string | null; resource_id: string | null; deck: string | null; ord: number; section_id: string | null }
export interface SectionRow { content_ranges?: string | null; id: string; resource_id: string; board_id: string; ord: number; label: string; first_page: number; last_page: number; kind: string | null; tokens: number | null }
// No data or page_text: the bytes are fetched by id from resource_blobs where needed.
export interface ResourceRow { id: string; board_id: string; filename: string | null; mime: string | null; text: string | null; tokens: number | null; included: number; created_at: number; kind: string | null; origin_url: string | null; bytes_len: number | null; done_at?: number | null; generation?: number }
export interface MarkReplyRow { id: string; mark_id: string; author: string; text: string; created_at: number }
export interface MarkRow { id: string; resource_id: string; page: number | null; start_off: number; end_off: number; quote: string; note: string | null; rects: string | null; box?: string | null; created_at: number }
export interface MintedRow {
  id: string; pair_id: string | null; variant: string; state: string;
  front: string; back: string | null; source: string | null; meta: string | null;
  opens_at: number; created_at: number; deck: string | null;
  card_id?: string | null;
  board_id?: string; board_title?: string;
  rev?: number;
}
export interface PlanGroupRow { id: string; name: string; ord: number }
export interface PlanMilestoneRow { id: string; name: string; due: string; note: string; done_at: number | null; ord: number }
export interface PlanPlaceRow { item: string; group_id: string | null; milestone_id: string | null; pinned: number; ord: number | null }
export interface BoardRow { id: string; title: string; type: string; touched_at?: number | null }
export interface FeedbackRow { id: string; board_id: string | null; kind: string; card_id: string | null; deck: string | null; message_idx: number | null; context: string | null; comment: string; resolved: number; created_at: number }
export interface ResourceNameRow { id: string; filename: string | null; mime: string | null; kind: string | null }
export interface CourseRow { slug: string; title: string; meta: string | null }
export interface CardRow { id: string; deck: string; type: string; payload: string; ord: number; rev?: number }
export interface TreeRow { section_id: string; resource_id: string; board_id: string; title: string; question: string; json: string | null; ascii: string | null; status: string; error: string | null; cards: number; updated_at: number; rev?: number }
export interface TreeStatusRow { section_id: string; resource_id: string; status: string; cards: number; error: string | null; updated_at: number; title: string }
export interface SourceTreeRow { resource_id: string; board_id: string; title: string; question: string; json: string | null; ascii: string | null; status: string; error: string | null; updated_at: number }
export interface MessageRow { id: number; board_id: string; role: string; text: string; calls: string | null; node_ids: string | null; idx: number; created_at: number; archived: number; resource_id: string | null; ask_id?: string | null }
