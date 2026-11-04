export const ROUTES = ["library", "board", "reader", "review", "cram", "keeps"] as const;
export type Route = (typeof ROUTES)[number];

/** `words`: asked in the fold under the words picked, on the open source's thread; no dock */
export const ASK_THREADS = ["library", "board", "source", "card", "words"] as const;
export type AskThread = (typeof ASK_THREADS)[number];

export const CARD_VERBS = ["new", "edit", "delete", "grade", "grade-local", "history", "jump", "keep", "drill"] as const;
export type CardVerb = (typeof CARD_VERBS)[number];

export const SOURCE_VERBS = ["add", "rename", "done", "delete", "file", "redistil"] as const;
export type SourceVerb = (typeof SOURCE_VERBS)[number];

export const BOARD_ACTIONS = ["rename", "delete"] as const;
export type BoardAction = (typeof BOARD_ACTIONS)[number];

export interface SurfaceSpec {
  route: Route;
  ask: AskThread;
  askSelection?: true;
  replyToCard: true;
  card: CardVerb[];
  annotate?: true;
  plan?: true;
  download?: true;
  sources: SourceVerb[];
  boardActions?: BoardAction[];
  imports: boolean;
  feedback: true;
  suggest: true;
  keys: string;
}

export const SPEC_FIELDS = [
  "route", "ask", "askSelection", "replyToCard", "card", "annotate", "plan", "download",
  "sources", "boardActions", "imports", "feedback", "suggest", "keys",
] as const satisfies readonly (keyof SurfaceSpec)[];

export const LIVE = ["ask", "askSelection", "replyToCard"] as const satisfies readonly (keyof SurfaceSpec)[];

export const PENDING: Partial<Record<Route, (typeof LIVE)[number][]>> = {};

export const SURFACES: Record<Route, SurfaceSpec> = {
  library: {
    route: "library",
    ask: "library",
    replyToCard: true,
    card: ["new", "edit", "delete"],
    sources: ["add", "rename", "delete", "file"],
    boardActions: ["rename", "delete"],
    imports: true,
    feedback: true,
    suggest: true,
    keys: "library",
  },
  board: {
    route: "board",
    ask: "board",
    replyToCard: true,
    card: ["new"],
    plan: true,
    download: true,
    sources: ["add", "rename", "done", "delete", "redistil"],
    boardActions: ["rename", "delete"],
    imports: true,
    feedback: true,
    suggest: true,
    keys: "board",
  },
  reader: {
    route: "reader",
    ask: "words",
    askSelection: true,
    replyToCard: true,
    card: ["new", "edit", "delete", "grade", "history", "jump", "drill"],
    annotate: true,
    sources: ["add", "redistil"],
    imports: true,
    feedback: true,
    suggest: true,
    keys: "reader",
  },
  review: {
    route: "review",
    ask: "card",
    askSelection: true,
    replyToCard: true,
    card: ["new", "edit", "delete", "grade", "history", "jump"],
    sources: [],
    imports: true,
    feedback: true,
    suggest: true,
    keys: "review",
  },
  cram: {
    route: "cram",
    ask: "card",
    askSelection: true,
    replyToCard: true,
    // a real delete; "drop from this cram" stays a separate local verb. Off the schedule by design.
    card: ["new", "edit", "delete", "grade-local", "history", "jump"],
    sources: [],
    imports: false,
    feedback: true,
    suggest: true,
    keys: "cram",
  },
  keeps: {
    route: "keeps",
    ask: "board",
    askSelection: true,
    replyToCard: true,
    card: ["new", "edit", "delete", "history", "jump", "keep"],   // delete ≠ un-keep
    sources: [],
    imports: false,
    feedback: true,
    suggest: true,
    keys: "keeps",
  },
};
