// Enumerates every interleaving of EVENTS up to BOUND against the real modules and a fake server, checking
// after each step: idle and "saved" means the server holds the box's text; no save overwrites unseen text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NotesSave } from "./notes-save.ts";
import { Store } from "./store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "./mutate.ts";
import { notesSender } from "./entities/notes.ts";
import { applyBoardState, notesKey } from "./entities/boards.ts";
import type { BoardState } from "../../shared/types/index.ts";

type Board = "b1" | "b2";
type Writer = "this" | "other" | "restore" | "start";
interface Doc { text: string; notesRev: number; rev: number; writer: Writer }
interface Wired { req: SendRequest; resolve(a: SendAnswer): void; reject(e: unknown): void }
type Fields = Record<string, unknown>;

const BOARDS: Board[] = ["b1", "b2"];
const START = { rev: 10, docs: { b1: { text: "c", notesRev: 4, rev: 10, writer: "start" }, b2: { text: "d", notesRev: 1, rev: 9, writer: "start" } } as Record<Board, Doc> };
const idle = () => new Promise<void>((resolve) => setImmediate(resolve));
const lost = () => Object.assign(new Error("Failed to fetch"), { name: "TypeError" });
const fields = (o: object) => o as unknown as Fields;

class World {
  readonly store = new Store();
  readonly server = { epoch: "e1", rev: START.rev, docs: structuredClone(START.docs), receipts: new Map<string, SendAnswer>() };
  readonly wire: Wired[] = [];
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  private nextTimer = 1;
  beat: (() => void) | null = null;
  readonly m: Mutator;
  readonly ns: NotesSave;
  /** what the box shows (boardNotes.ts's view): seed's answer, the typing, Use theirs */
  box: { board: Board | null; text: string } = { board: null, text: "" };
  read: { board: Board; doc: Doc; epoch: string; current: boolean } | null = null;
  /** a save the server has decided whose answer is not heard yet (take, release) */
  late: { board: Board; answer: SendAnswer; current: boolean; hear(): void; lose(): void } | null = null;
  /** the service worker's copy of each board: the last read answered */
  readonly shelf: Record<Board, { doc: Doc; epoch: string }> = { b1: { doc: { ...START.docs.b1 }, epoch: "e1" }, b2: { doc: { ...START.docs.b2 }, epoch: "e1" } };
  readonly lastShown: Partial<Record<Board, { text: string; live: boolean }>> = {};
  /** the box has heard the board since anyone but this tab last changed it */
  readonly heard: Record<Board, boolean> = { b1: false, b2: false };
  /** every text this tab's box showed for the board, "theirs" in a conflict included */
  readonly seen: Record<Board, Set<string>> = { b1: new Set(), b2: new Set() };
  readonly counts = { other: 0, restore: 0, shelf: 0 };
  violation: string | null = null;

  constructor() {
    this.m = new Mutator({
      store: this.store,
      transport: (req) => new Promise<SendAnswer>((resolve, reject) => { this.wire.push({ req, resolve, reject }); }),
      setTimer: (fn, ms) => { const id = this.nextTimer++; if (ms < 20_000) this.timers.set(id, { fn, ms }); return id; },
      clearTimer: (id) => { this.timers.delete(id as number); },
      surface: () => {},
    });
    this.ns = new NotesSave({
      store: this.store,
      send: notesSender(this.m, this.store),
      failed: () => {},
      setTimer: (fn) => { this.beat = fn; return 1; },
      clearTimer: () => { this.beat = null; },
    });
  }

  // the fake server: PUT /api/boards/:id/notes, receipt mode atomic
  answer(req: SendRequest): SendAnswer {
    const key = req.headers["Idempotency-Key"];
    const had = this.server.receipts.get(key);
    if (had) return { ...had, replay: true };
    const board = req.path.split("/")[3] as Board;
    const doc = this.server.docs[board];
    const text = String((JSON.parse(req.body ?? "{}") as { text?: unknown }).text ?? "");
    const want = req.headers["If-Match"] === undefined ? null : Number(req.headers["If-Match"].replace(/"/g, ""));
    if (want !== null && want !== doc.notesRev) {
      return { status: 409, body: { error: "changed elsewhere", conflict: { rev: doc.notesRev, value: { text: doc.text } } }, rev: this.server.rev, epoch: this.server.epoch };
    }
    if (doc.writer !== "this" && doc.text !== text && !this.seen[board].has(doc.text)) {
      this.violation ??= `I3: this tab's save of ${JSON.stringify(text)} wrote over ${JSON.stringify(doc.text)} (${doc.writer}'s) on ${board}, which its box never showed`;
    }
    this.server.rev++;
    this.server.docs[board] = { text, notesRev: doc.notesRev + 1, rev: this.server.rev, writer: "this" };
    const answer = { status: 200, body: { rev: this.server.rev, notesRev: doc.notesRev + 1 }, rev: this.server.rev, epoch: this.server.epoch };
    this.server.receipts.set(key, answer);
    return answer;
  }
  /** someone other than this tab changed a board: what the box heard of it is old now */
  changed(board: Board): void {
    this.heard[board] = false;
    if (this.read?.board === board) this.read.current = false;
    if (this.late?.board === board) this.late.current = false;
  }
  state(board: Board): BoardState {
    const d = this.server.docs[board];
    return { board: { id: board }, notes: d.text, notesRev: d.notesRev, rev: d.rev } as unknown as BoardState;
  }
  toStore(board: Board, doc: Doc, epoch: string, origin: "wire" | "shelf" = "wire"): void {
    applyBoardState({ board: { id: board }, notes: doc.text, notesRev: doc.notesRev, rev: doc.rev } as unknown as BoardState, { epoch, origin }, this.store);
  }
  toBox(board: Board, doc: Doc, epoch: string, stale = false): void {
    this.box = { board, text: this.ns.seed(board, doc.text, { rev: doc.notesRev, epoch, stale }) };
  }
  saw(): void {
    const { board, text } = this.box;
    if (!board) return;
    this.lastShown[board] = { text, live: !this.ns.stale };
    this.seen[board].add(text);
    const theirs = fields(this.ns).theirs;
    if (typeof theirs === "string") this.seen[board].add(theirs);
  }
  idle(): boolean { return !this.late && !this.wire.length && !this.m.pending().length && !fields(this.ns).inflight && !this.beat; }
  /** a board this tab can vouch for: its last write is this tab's, or the box heard it since */
  vouched(board: Board): boolean { return this.server.docs[board].writer === "this" || this.heard[board]; }
  owedTo(board: Board): boolean {
    const f = fields(this.ns);
    return (f.left as Map<string, unknown>).has(board) || (f.conflicted as Set<string>).has(board);
  }

  check(): string | null {
    if (this.violation) return this.violation;
    if (!this.idle()) return null;
    const s = this.ns.getSnapshot();
    const open = this.box.board;
    if (open && !this.ns.stale) {
      if (!s.saved && !s.conflict && s.error === null) return `I4: idle on ${open}, nothing failed and nothing asked, yet the badge says "…"`;
      const server = this.server.docs[open];
      if (s.saved && !s.conflict && !this.ns.owes() && this.vouched(open) && server.text !== this.box.text) {
        return `I1: the box on ${open} says saved with ${JSON.stringify(this.box.text)}, nothing owed, but the server holds ${JSON.stringify(server.text)}`;
      }
    }
    for (const board of BOARDS) {
      const shown = this.lastShown[board];
      if (board === open || !shown?.live || this.owedTo(board) || !this.vouched(board)) continue;
      const server = this.server.docs[board];
      if (server.text !== shown.text) return `I2: ${board} was left showing ${JSON.stringify(shown.text)} with nothing owed, but the server holds ${JSON.stringify(server.text)}`;
    }
    return null;
  }

  // every field of the modules, random keys renamed, so a state is never explored twice
  fingerprint(): string {
    const keys = new Map<string, number>();
    const key = (k: string) => { if (!keys.has(k)) keys.set(k, keys.size); return keys.get(k); };
    const errors = new Map<unknown, number>();
    const plain = (v: unknown): unknown => {
      if (v instanceof Error) {
        if (!errors.has(v)) errors.set(v, errors.size);
        const e = v as Error & { status?: number; retryable?: boolean; conflict?: unknown };
        return { error: errors.get(v), name: e.name, status: e.status, retryable: e.retryable, conflict: e.conflict };
      }
      if (v instanceof Map) return [...v].map(([k, x]) => [k, plain(x)]);
      if (v instanceof Set) return [...v];
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
      return v;
    };
    const ns = Object.fromEntries(Object.entries(fields(this.ns))
      .filter(([k, v]) => typeof v !== "function" && k !== "o" && k !== "listeners")
      .map(([k, v]) => [k, k === "timer" ? v !== null : plain(v)]));
    const wire = this.wire.map(({ req }) => [key(req.headers["Idempotency-Key"]), req.body, req.headers["If-Match"] ?? null, !!req.keepalive]);
    const items = (fields(this.m).items as { state: string; body: string; key: string; attempts: number; sent: boolean; conflicts: number; carrying: number; timer: unknown; op: { base?: () => number | null; keepalive?: boolean } }[])
      .map((i) => [i.state, i.body, key(i.key), i.attempts, i.sent, i.conflicts, i.carrying, i.timer !== null, i.op.base?.() ?? null, !!i.op.keepalive]);
    const receipts = [...this.server.receipts].map(([k, a]) => [key(k), a.status, a.body]);
    const store = BOARDS.map((b) => {
      const e = this.store.entry(notesKey(b));
      return e && [e.held, e.base, e.rev, e.stamp, e.epoch, e.origin, e.layers.length, e.view];
    });
    return JSON.stringify([ns, wire, items, receipts, store, fields(this.m).aliveBytes, this.server.epoch, this.server.rev, this.server.docs,
      this.box, this.read, this.late && [this.late.board, this.late.answer, this.late.current], this.shelf, this.lastShown, this.heard, BOARDS.map((b) => [...this.seen[b]].sort()), this.counts]);
  }
}

interface Event { name: string; on(w: World): boolean; run(w: World): void | Promise<void> }
const typing = (w: World) => !!w.box.board && !w.ns.stale;
const retryTimer = (w: World) => [...w.timers.keys()][0];
const retry = (w: World) => { const id = retryTimer(w); const t = w.timers.get(id)!; w.timers.delete(id); t.fn(); };
// a retry firing and its answer are one event: nothing in the box or store differs between them
const answered = (w: World) => w.wire.length > 0 || w.timers.size > 0;
const deliver = async (w: World, how: "ok" | "lostAfter" | "lostBefore" | 401 | 503) => {
  if (!w.wire.length) { retry(w); await idle(); }
  const { req, resolve, reject } = w.wire.shift()!;
  if (how === "ok" || how === "lostAfter") {
    const a = w.answer(req);
    if (how === "lostAfter") return reject(lost());
    const board = req.path.split("/")[3] as Board;
    if (a.status === 409) w.heard[board] = true;               // the refusal carries the log as it stands
    return resolve(a);
  }
  if (how === "lostBefore") return reject(lost());
  resolve({ status: how, body: { error: how === 401 ? "sign in again" : "busy" }, rev: 0, epoch: "" });
};
const pause = (w: World) => { const beat = w.beat; w.beat = null; beat?.(); };
const opened = (w: World, board: Board) => {
  // openBoard: the read is answered (the service worker keeps it), the store takes it, then the box
  const doc = { ...w.server.docs[board] };
  w.shelf[board] = { doc, epoch: w.server.epoch };
  w.toStore(board, doc, w.server.epoch);
  w.toBox(board, doc, w.server.epoch);
  w.heard[board] = true;
};

export const EVENTS: Event[] = [
  { name: "type", on: typing, run: (w) => { w.box.text += "a"; w.ns.edit(w.box.text); pause(w); } },
  { name: "type-hold", on: (w) => typing(w) && !w.beat, run: (w) => { w.box.text += "a"; w.ns.edit(w.box.text); } },
  { name: "back", on: (w) => typing(w) && w.box.text.endsWith("a"), run: (w) => { w.box.text = w.box.text.slice(0, -1); w.ns.edit(w.box.text); pause(w); } },
  { name: "blur", on: (w) => !!w.beat, run: (w) => w.ns.flush() },
  { name: "keep-mine", on: (w) => w.ns.getSnapshot().conflict, run: (w) => w.ns.keepMine() },
  { name: "use-theirs", on: (w) => w.ns.getSnapshot().conflict, run: (w) => { w.box.text = w.ns.useTheirs(); } },
  { name: "ok", on: answered, run: (w) => deliver(w, "ok") },
  { name: "lost-after", on: answered, run: (w) => deliver(w, "lostAfter") },
  { name: "lost-before", on: answered, run: (w) => deliver(w, "lostBefore") },
  { name: "401", on: answered, run: (w) => deliver(w, 401) },
  { name: "503", on: answered, run: (w) => deliver(w, 503) },
  {
    name: "run-out", on: (w) => w.timers.size > 0,
    async run(w) {
      while (w.timers.size) { await deliver(w, "lostBefore"); await idle(); }
    },
  },
  ...BOARDS.map((b): Event => ({ name: `snap:${b}`, on: () => true, run: (w) => w.toStore(b, { ...w.server.docs[b] }, w.server.epoch) })),
  ...BOARDS.map((b): Event => ({ name: `open:${b}`, on: () => true, run: (w) => opened(w, b) })),
  {
    name: "read", on: (w) => !!w.box.board && !w.read,
    run: (w) => { const b = w.box.board!; const doc = { ...w.server.docs[b] }; w.read = { board: b, doc, epoch: w.server.epoch, current: true }; w.shelf[b] = { doc, epoch: w.server.epoch }; },
  },
  {
    name: "read-lands", on: (w) => !!w.read,
    run: (w) => { const r = w.read!; w.read = null; w.toStore(r.board, r.doc, r.epoch); w.toBox(r.board, r.doc, r.epoch); if (r.current) w.heard[r.board] = true; },
  },
  {
    name: "shelf:b1", on: (w) => w.counts.shelf < 1,
    run: (w) => { w.counts.shelf++; const { doc, epoch } = w.shelf.b1; w.toStore("b1", doc, epoch, "shelf"); w.toBox("b1", doc, epoch, true); },
  },
  {
    name: "live", on: (w) => !!w.box.board && w.ns.stale,
    run: (w) => {
      // BoardNotes.liveNotesFirst: the box is seeded from the live read, then the room's slot takes it
      const b = w.box.board!; const doc = { ...w.server.docs[b] };
      w.shelf[b] = { doc, epoch: w.server.epoch };
      w.toBox(b, doc, w.server.epoch);
      w.toStore(b, doc, w.server.epoch);
      w.heard[b] = true;
    },
  },
  ...BOARDS.map((b): Event => ({
    name: `other:${b}`, on: (w) => w.counts.other < 2 && !w.counts.restore,
    run: (w) => {
      w.counts.other++;
      const d = w.server.docs[b];
      w.server.rev++;
      w.server.docs[b] = { text: `${d.text}o`, notesRev: d.notesRev + 1, rev: w.server.rev, writer: "other" };
      w.changed(b);
    },
  })),
  {
    name: "restore", on: (w) => w.counts.restore < 1 && !w.counts.other,
    run: (w) => {
      // a restore: a read the old server answered cannot land after the new one's, so the read out is lost
      w.counts.restore++;
      w.read = null;
      if (w.late) { const l = w.late; w.late = null; l.lose(); }
      w.server.epoch = "e2"; w.server.rev = START.rev; w.server.receipts.clear();
      for (const b of BOARDS) { w.server.docs[b] = { ...START.docs[b], writer: "restore" }; w.changed(b); }
    },
  },
  {
    // the server decides the save on the wire now; its answer is heard later, at release
    name: "take", on: (w) => answered(w) && !w.late,
    async run(w) {
      if (!w.wire.length) { retry(w); await idle(); }
      const { req, resolve, reject } = w.wire.shift()!;
      const answer = w.answer(req);
      w.late = { board: req.path.split("/")[3] as Board, answer, current: true, hear: () => resolve(answer), lose: () => reject(lost()) };
    },
  },
  {
    name: "release", on: (w) => !!w.late,
    run: (w) => {
      const l = w.late!; w.late = null;
      // a refusal carries the log as it stood when it was decided
      if (l.answer.status === 409 && l.current) w.heard[l.board] = true;
      l.hear();
    },
  },
];
const byName = new Map(EVENTS.map((e) => [e.name, e]));

/** a fresh room on b1, then `path`: the world after it, the first violation and where */
export async function replay(path: readonly string[]): Promise<{ w: World; violation: string | null; at: number }> {
  const w = new World();
  opened(w, "b1");
  w.saw();
  await idle();
  for (let i = 0; i < path.length; i++) {
    const e = byName.get(path[i])!;
    if (!e.on(w)) throw new Error(`${path.slice(0, i + 1).join(" → ")}: not possible here`);
    await e.run(w);
    await idle();
    w.saw();
    const violation = w.check();
    if (violation) return { w, violation, at: i };
  }
  return { w, violation: null, at: -1 };
}

/** breadth first over every sequence of EVENTS up to `bound`, states reached before skipped */
export async function explore(bound: number, opts: { stopAt?: number } = {}): Promise<{ states: number; runs: number; counterexamples: { path: string[]; violation: string }[] }> {
  const reached = new Set<string>();
  const counterexamples: { path: string[]; violation: string }[] = [];
  let frontier: { path: string[]; next: string[] }[] = [];
  let runs = 0;
  const start = await replay([]);
  reached.add(start.w.fingerprint());
  frontier.push({ path: [], next: EVENTS.filter((e) => e.on(start.w)).map((e) => e.name) });
  for (let depth = 0; depth < bound && frontier.length; depth++) {
    const deeper: typeof frontier = [];
    for (const node of frontier) {
      for (const name of node.next) {
        const path = [...node.path, name];
        const { w, violation } = await replay(path);
        runs++;
        if (violation) {
          counterexamples.push({ path, violation });
          if (counterexamples.length >= (opts.stopAt ?? Infinity)) return { states: reached.size, runs, counterexamples };
          continue;
        }
        const fp = w.fingerprint();
        if (reached.has(fp)) continue;
        reached.add(fp);
        deeper.push({ path, next: EVENTS.filter((e) => e.on(w)).map((e) => e.name) });
      }
    }
    frontier = deeper;
  }
  return { states: reached.size, runs, counterexamples };
}

// Reported counterexamples, each a sequence the search enumerates; each fails on the code before its fix.
export const KNOWN: [string, string[]][] = [
  ["notes-1: a read answered before the box's own save lands after it", ["read", "type", "ok", "read-lands"]],
  ["notes-2: a lost answer, the box edited back to the confirmed text, another board", ["type", "lost-after", "run-out", "back", "open:b2"]],
  ["typing deleted back inside the beat leaves the badge at '…'", ["type-hold", "back"]],
  ["a restore onto a backup, then the board reopened", ["type", "ok", "open:b2", "restore", "open:b1"]],
  ["a lost answer, its retry refused 401, the box edited back, another board", ["type", "lost-after", "401", "back", "open:b2"]],
  ["P1: the lost save reaches the store by a snapshot, its retry 401, edited back", ["type", "lost-after", "snap:b1", "401", "back"]],
  ["P1: the same, the board reopened while the save retries", ["type", "lost-after", "open:b1", "401", "back"]],
  ["P1b: the lost save reaches the store, the retries run out, edited back", ["type", "lost-after", "snap:b1", "run-out", "back"]],
  ["P1c: reopened while retrying, the retries run out, edited back, another board", ["type", "lost-after", "open:b1", "run-out", "back", "open:b2"]],
  ["P2: a restore, the live read seeding the box before the store (liveNotesFirst)", ["type", "ok", "open:b2", "restore", "shelf:b1", "live"]],
  ["Keep mine over a conflict whose box reads as the old confirmed text sends nothing", ["type", "back", "other:b1", "ok", "keep-mine"]],
  ["a board left in that conflict drops it", ["type", "back", "other:b1", "ok", "open:b2"]],
  ["a reopen's newer read under a draft typed back to the saved text", ["type", "back", "type-hold", "ok", "other:b1", "open:b1"]],
  ["a replayed receipt, older than a read the box heard since", ["type", "lost-after", "other:b1", "open:b1", "ok"]],
  ["a replayed receipt for a board left since", ["type", "lost-after", "other:b1", "open:b1", "open:b2", "ok"]],
  ["a 409's text taken back by a late read", ["type", "read", "other:b1", "ok", "use-theirs", "read-lands"]],
  ["two lost saves over one revision, and a read at it (bound 7)", ["type", "read", "lost-after", "run-out", "back", "401", "read-lands"]],
  ["late409: a refusal decided before a newer write elsewhere, heard after a read of it (bound 7)", ["type", "other:b1", "take", "other:b1", "open:b1", "release", "use-theirs"]],
];

/** Covers every known counterexample but the deeper sweep's in ~10 s; --explore 7 goes one deeper. */
export const BOUND = 6;

for (const [name, path] of KNOWN) {
  test(`model: ${name} (${path.join(" → ")})`, async () => {
    const { violation, at } = await replay(path);
    assert.equal(violation, null, `after ${path.slice(0, at + 1).join(" → ")}`);
  });
}

test(`model: no sequence of up to ${BOUND} events breaks the invariants`, async () => {
  const deeper = KNOWN.filter(([, path]) => path.length > BOUND);
  assert.ok(deeper.every(([name, path]) => name.endsWith(`(bound ${path.length})`)), "every counterexample reported but the deeper sweep's is within the bound");
  const { states, runs, counterexamples } = await explore(BOUND, { stopAt: 5 });
  assert.deepEqual(counterexamples.map((c) => `${c.path.join(" → ")}: ${c.violation}`), []);
  assert.ok(states > 10_000, `the search reached ${states} states in ${runs} runs`);
});

if (process.argv.includes("--explore")) {
  const bound = Number(process.argv[process.argv.indexOf("--explore") + 1]) || BOUND;
  const t0 = Date.now();
  const r = await explore(bound, { stopAt: 20 });
  console.log(`bound ${bound}: ${r.states} states, ${r.runs} runs, ${Date.now() - t0} ms`);
  for (const c of r.counterexamples) console.log(`${c.path.join(" → ")}
    ${c.violation}`);
  if (process.argv.includes("--known")) for (const [name, path] of KNOWN) { const v = await replay(path); console.log(`${v.violation ? "FAILS" : "holds"}  ${name}${v.violation ? `
    ${v.violation}` : ""}`); }
}
