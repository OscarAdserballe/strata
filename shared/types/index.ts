export interface Board { id: string; title: string; type: string }

export interface Message { role: string; text: string; idx: number; resourceId: string | null; /** the words it was asked at, when it was */ ask?: string | null }
/** Words a question was asked at; its turns are the source thread's messages that name it. */
export interface Ask { id: string; resourceId: string; page: number | null; start: number; end: number; quote: string; rects: number[][]; box?: string | null; createdAt: number }

export interface ResourceMeta {
  id: string;
  filename: string;
  mime: string;
  /** pdf → bytes + pdf.js, anchored by page · text → markdown prose · transcript → markdown by timestamp */
  kind: string;
  tokens: number;
  included: boolean;
  originUrl: string | null;
  read: "unread" | "opened" | "read";
  readPct: number;
  readMs: number;
  createdAt: number;
  lastReadAt: number | null;
  doneAt: number | null;
  /** bumped each time the source is revised in place; part of its URLs so no cache serves the old bytes */
  generation?: number;
}

export interface Budget { usedTokens: number; targetTokens: number; over: boolean }

export interface Pair {
  id: string;
  label: string;
  resourceId: string | null;
  deck: string | null;
  ord: number;
  sectionId: string | null;
}

/** An author-given division inside a source (a book's chapter). lastPage 0 = to the end. */
export interface Section {
  id: string;
  resourceId: string;
  ord: number;
  label: string;
  firstPage: number;
  lastPage: number;
  /** work | apparatus — whether it gets a tree and a deck, or only stays readable */
  kind: string;
  tokens: number;
}

export interface TreeStatus {
  status: string;
  cards: number;
  error: string | null;
  at: number;
}

/** Offsets are a hint and the quote is the authority; rects are fractions of the page. */
/** Said under a note: by you, or by an agent answering it. */
export interface MarkReply { id: string; author: "you" | "agent"; text: string; at: number }

export interface Mark {
  id: string;
  resourceId: string;
  page: number | null;
  start: number;
  end: number;
  quote: string;
  note: string | null;
  rects: number[][];
  /** a note on a page's labelled box (data-strata-id) rather than on words */
  box?: string | null;
  createdAt: number;
  replies?: MarkReply[];
}

export interface Minted {
  id: string;
  pairId: string | null;
  variant: string;
  state: string;
  front: string;
  back: string | null;
  source: string;
  deck: string | null;
  meta: Record<string, unknown>;
  opensAt: number;
  createdAt: number;
  cardId: string | null;
  /** the row's revision stamp: the If-Match base of the next edit */
  rev?: number;
}

export interface MintedEverywhere extends Minted { boardId: string; boardTitle: string }

export type Touched = Record<string, { seen: number; done: number; last?: string }>;

export interface CardsSeen { seen: string[]; done: string[] }

/* `places` is sparse: a missing key means ungrouped and unpinned, never an error. */
export interface PlanGroup { id: string; name: string; ord: number }
/** `due` is free text ("before the exam"), not a date; `doneAt` null = not reached. */
export interface PlanMilestone { id: string; name: string; due: string; note: string; doneAt: number | null; ord: number }
/** `ord` is the item's position inside its group; null = never placed (sorts last). */
export interface PlanPlace { group: string | null; milestone: string | null; pinned: boolean; ord: number | null }
export interface BoardPlan { purpose: string; groups: PlanGroup[]; milestones: PlanMilestone[]; places: Record<string, PlanPlace>; rev?: number }

/* Revs are stamps from one room counter: of two answers about one scope, the higher rev is newer. */
export interface NotesSaved { rev: number; notesRev: number }
export interface BoardStatus { rev?: number; busy: boolean; version: string }
export interface PlanAnswer { plan: BoardPlan; rev?: number }
export interface MarkAnswer { id?: string; mark: Mark; rev?: number }
export interface MarkRemoved { ok: boolean; id: string; rev?: number }
export interface ThreadPage { messages: Message[]; before: number | null; rev?: number }
export interface DeckRead { deck: { slug: string; title: string }; cards: Card[]; rev?: number }
export interface DeckIgnored { cards: Card[]; rev?: number }
export interface CardEditAnswer { ok: boolean; card: Card; rev?: number }
export interface TreeSaved { ok: boolean; cards: number; state: BoardState; treeRev?: number }
/** 409 from a stale If-Match: the document as it stands and its rev; nothing was written. */
export interface ConflictAnswer<T = unknown> { error: "changed elsewhere"; conflict: { rev: number; value: T } }

export interface BoardState {
  board: Board;
  messages: Message[];
  resources: ResourceMeta[];
  budget: Budget;
  deck: string | null;
  pairs: Pair[];
  notes: string;
  trees: Record<string, TreeStatus>;
  sections: Section[];
  marks: Mark[];
  asks?: Ask[];
  minted: Minted[];
  mintedEverywhere: MintedEverywhere[];
  /** per thread ("" = the board's own): the idx of the oldest message still in the model's context */
  windowFrom: Record<string, number>;
  touched: Touched;
  plan: BoardPlan;
  rev?: number;
  notesRev?: number;
}

export interface BoardListEntry extends Board {
  resources: { id: string; filename: string; kind: string }[];
  msgCount: number;
  touchedAt: number | null;
  lastRead?: { resourceId: string; filename: string; deepest: number } | null;
}

export interface DeckSummary {
  slug: string; title: string; meta: unknown; total: number; ignored: number;
  kept: number;
  benched: boolean;
}

export interface Card extends Record<string, unknown> {
  id: string;
  deck: string;
  type: string;
  ord: number;
  rev?: number;
}

export interface ReviewCard extends Card {
  course: string;
  courseTitle: string;
  rung: number;
  dueAt: number;
}

/** Only kept cards enrol; unkeptDue counts due cards outside the kept set. */
export interface ReviewState {
  cards: ReviewCard[];
  total: number;
  nextDueAt: number | null;
  unkeptDue: number;
}

export interface CardHistory {
  addedAt: number | null;
  sourceAddedAt: number | null;
  keptAt: number | null;
  reviews: { at: number; got: boolean }[];
}

export interface DeckKeepsResponse {
  ids: string[];
  rev?: number;
  state?: BoardState;
}

export interface DeckKeepMintedResponse {
  ids: string[];
  rev?: number;
  card: Card;
  state: BoardState;
}

export interface CollectionGroup {
  deck: string;
  label: string;
  total: number;
  kept: number;
  /** claims covered by kept cards / the tree's claim count; null when the deck has no usable tree */
  ideasKept: number | null;
  ideasTotal: number | null;
  lastKeepAt: number | null;
  benched: boolean;
  cards: Card[];
}
export interface BoardCollectionResponse { board: string; groups: CollectionGroup[] }

export interface LibraryBoard {
  id: string;
  title: string;
  kept: number;
  total: number;
  decksBenched: number;
  decksTotal: number;
  lastKeepAt: number | null;
  benched: boolean;
  groups: CollectionGroup[];
}
export interface LibraryCollectionResponse {
  boards: LibraryBoard[];
  unfiled: CollectionGroup[];
}

/** `missed`: missed at least once today; `got`: the final verdict */
export interface SessionMet {
  card: string;
  front: string;
  type: string;
  got: boolean;
  missed: boolean;
}

/** `met` empty: the claim is part of the shape but was not visited today */
export interface SessionClaim {
  id: string;
  label: string;
  depth: number;
  kind?: string | null;
  met: SessionMet[];
}

export interface SessionTopic {
  course: string;
  courseTitle: string;
  label: string | null;
  board: string | null;
  boardTitle: string | null;
  section: string | null;
  resource: string | null;
  met: number;
  got: number;
  missed: number;
  deckTotal: number;
  dueLeft: number;
  tree: { title: string; question: string; claims: SessionClaim[] } | null;
  loose: SessionMet[];
}

export interface ReviewTreeResponse {
  course: string;
  courseTitle: string;
  label: string | null;
  board: string | null;
  pair: string | null;
  section: string | null;
  resource: string | null;
  tree: { title: string; question: string; claims: SessionClaim[] } | null;
}

export interface SessionMapResponse {
  since: number;
  cards: number;
  got: number;
  missed: number;
  sittings: number;
  minutes: number;
  dueLeft: number;
  topics: SessionTopic[];
}

export interface HealthResponse {
  ok: boolean;
  gemini: boolean;
  chat: string;
  chatThinking: number | string;
  distil: string;
  capture: boolean;
  tavily: boolean;
  firecrawl: boolean;
}

export type CaptureResponse =
  | { kind: "youtube"; url: string; title: string; author: string | null; why?: string | null; ytDlpCommand: string; ytDlpCommands: { macos: string; windows: string } }
  | { kind: "article" | "transcript"; resourceId: string; pairId: string; title: string; state: BoardState };

export interface CaptureFinishResponse {
  kind: "transcript";
  resourceId: string;
  pairId: string;
  cues: number;
  state: BoardState;
}

/** `onHome` is an older client's word for the board page, still honoured */
export interface Here {
  surface?: string | null;
  sectionId?: string | null;
  page?: number | null;
  card?: { prompt?: string; revealed?: boolean; shownMs?: number | null; role?: "subject" | "scenery" } | null;
  onHome?: boolean;
  onBoard?: boolean;
  thread?: string | null;
}

export interface TreeNode {
  id: string;
  label: string;
  kind?: string;
  anchor?: string;
  excerpt?: string;
  questions?: string[];
  children?: TreeNode[];
}

export interface TreeResponse {
  status: string;
  error: string | null;
  cards: number;
  title: string;
  question: string;
  ascii: string | null;
  tree: { title?: string; question?: string; nodes: TreeNode[] } | null;
  deck?: string;
  sections?: { id: string; label: string; firstPage: number; lastPage: number; status: string; cards: number; deck: string }[];
  rev?: number;
}

export interface RegisterEntry {
  resourceId: string;
  pairId: string | null;
  boardId: string;
  boardTitle: string;
  unfiled: boolean;
  filename: string;
  kind: string;
  originUrl: string | null;
  createdAt: number;
  /** fresh · reading · distilling · failed · to-review · kept · done */
  status: RegisterStatus;
  readPct: number;
  kept: number;
  cards: number;
  waiting: boolean;
}

export type RegisterStatus =
  | "fresh" | "reading" | "distilling" | "failed" | "to-review" | "kept" | "done";

export interface RegisterOverview {
  sources: number;
  waiting: number;
  unfiled: number;
  landed: number;
  through: number;
  kept: number;
  keptTotal: number;
}

export interface KeptAt { boardId: string | null; at: number }

export interface RegisterResponse {
  entries: RegisterEntry[];
  overview: RegisterOverview;
  keptRecent: KeptAt[];
}
