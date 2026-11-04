import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { build } from "esbuild";

const SRC = process.env.CAPTURE_MODEL_SRC || import.meta.dirname;
const ALL = !!process.env.CAPTURE_MODEL_ALL;
const FLUSH = Number(process.env.CAPTURE_MODEL_FLUSH || 12);
const PEEK = `module.exports.__peek = () => ({ held: typeof held === "undefined" ? (typeof keys === "undefined" ? undefined : keys) : held, said: typeof said === "undefined" ? undefined : said });`;
const bundled = await build({ entryPoints: [join(SRC, "Capture.tsx")], bundle: true, write: false, format: "cjs", logLevel: "error", footer: { js: PEEK } });
// keys minted from a counter: quicker than system randomness and unique within a run
const factory = new Function("module", "exports", "crypto", bundled.outputFiles[0].text) as (m: { exports: Record<string, any> }, e: unknown, c: unknown) => void;
const counting = () => { let n = 0; return { getRandomValues: (a: Uint8Array) => { a.fill(0); new DataView(a.buffer).setUint32(0, ++n); return a; } }; };
Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel", onLine: true }, configurable: true });
Object.assign(globalThis, { document: { body: {} } });

interface El { type: unknown; props: Record<string, any>; kids: unknown[] }
const Fake = { Fragment: "", createElement: (type: unknown, props: Record<string, any> | null, ...kids: unknown[]): El => ({ type, props: props || {}, kids }) };
function find(n: unknown, ok: (e: El) => boolean): El | null {
  if (Array.isArray(n)) { for (const k of n) { const f = find(k, ok); if (f) return f; } return null; }
  if (!n || typeof n !== "object") return null;
  return ok(n as El) ? (n as El) : find((n as El).kids, ok);
}

type Bytes = "X" | "Y";
const BYTES: Bytes[] = ["X", "Y"];
const TALK = "https://www.youtube.com/watch?v=model";
const VTT: Record<Bytes, string> = { X: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nThe X talk.\n", Y: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nThe Y talk.\n" };
const LINK: Record<Bytes, string> = { X: "https://example.org/x", Y: "https://example.org/y" };
const bytesIn = (s: string): Bytes | "-" => (s.includes("The X talk") || s.includes(LINK.X) ? "X" : s.includes("The Y talk") || s.includes(LINK.Y) ? "Y" : "-");
const READ = { title: "A talk", author: "A channel" }, FALLBACK = { title: TALK, author: "" };
const bodyOf = (text: string, title?: string) => `${bytesIn(text)}${title === FALLBACK.title ? "'" : ""}`;

interface Model {
  name: string;
  step: "captions" | "url";
  form: boolean;
  paste: boolean;
  refusals: string[];
  drift: boolean;
}
export const CAPTIONS: Model = { name: "captions", step: "captions", form: false, paste: true, refusals: ["5xx", "4xx"], drift: true };
export const LINKS: Model = { name: "link", step: "url", form: true, paste: false, refusals: ["5xx"], drift: false };

interface Answer { status: number; res?: string; snap?: string[] }
interface Act { bytes: Bytes; start: number }
interface Req {
  n: number; door: string; route: string; bytes: Bytes; body: string; key: string | undefined; act: Act; tries: number;
  srv: "wire" | "at" | "done"; cli: "out" | "settled"; answer?: Answer;
  ok(v: unknown): void; no(e: unknown): void;
}
interface Source { bytes: Bytes; alive: boolean; seenAt: number }

interface Judging { e: string; req: Req | undefined; before: any; upBefore: string | null }
type Walked = World & { invalid?: string; walked: string[] };

class World {
  C: Record<string, any>;
  cap: any = null;
  dialogs = 0;
  tokens = new Map<object, string>();
  acts = new Map<string, Act>();
  formBusy = false;
  formDraft: Record<string, string> = {};
  formAnswer: Answer | null = null;
  reqs: Req[] = [];
  receipts = new Map<string, { route: string; body: string; res: string }>();
  sources = new Map<string, Source>();
  toasted = new Set<string>();
  keyBodies = new Map<string, string>();
  presses = 0;
  t = 0;
  acting: { door: string; act: Act; tries: number } | null = null;
  landings: { res: string; told: boolean; ghost: boolean }[] = [];
  bad: string | null = null;
  sets = 0;

  model: Model;
  constructor(model: Model) {
    this.model = model;
    const m = { exports: {} as Record<string, any> };
    factory(m, m.exports, counting());
    this.C = m.exports;
    this.C.bind({
      React: Fake, createPortal: (el: unknown) => el,
      api: {
        log() {},
        capture: (_id: string, url: string, key?: string) => this.wire("capture", bodyOf(url), key),
        captureFinish: (_id: string, body: { vtt: string; title?: string }, key?: string) => this.wire("capture/finish", bodyOf(body.vtt, body.title), key),
      },
      resolve: async (b: string | null) => b ?? "b1",
      set: (next: any) => { this.sets++; this.cap = typeof next === "function" ? (this.cap ? next(this.cap) : null) : next; },
      now: () => this.cap,
      added() {},
      landed: (r: { resourceId: string; state: { resources: { id: string }[] } }, message: string | null) =>
        this.landings.push({ res: r.resourceId, told: !!message, ghost: !r.state.resources.some((x) => x.id === r.resourceId) }),
    });
  }

  fail(why: string) { this.bad ??= why; }

  wire(route: string, body: string, key: string | undefined): Promise<unknown> {
    if (!this.acting) throw new Error("a request that no step of the model made");
    const bytes = body[0] as Bytes;
    if (key !== undefined) {
      const was = this.keyBodies.get(key);
      if (was && was !== `${route} ${body}`) this.fail(`no 422: key ${key.slice(0, 6)} sent with ${was} and then ${route} ${body}`);
      this.keyBodies.set(key, `${route} ${body}`);
    }
    const { door, act, tries } = this.acting;
    return new Promise((ok, no) => {
      this.reqs.push({ n: this.reqs.length, door, route, bytes, body, key, act, tries, srv: "wire", cli: "out", ok, no });
    });
  }

  draw() { return this.C.default({ cap: this.cap, onClose: () => { this.cap = null; }, toast() {} }); }
  type(value: string) { find(this.draw(), (e) => e.type === "input" || e.type === "textarea")!.props.onChange({ target: { value } }); }
  pressButton() { find(this.draw(), (e) => e.type === "button" && e.kids.some((k) => k === "fetch it" || k === "add the transcript"))!.props.onClick(); }
  text(b: Bytes) { return this.model.step === "captions" ? VTT[b] : LINK[b]; }
  shown(): Bytes | "-" { return this.cap ? bytesIn(this.model.step === "captions" ? this.cap.vtt || "" : this.cap.url || "") : "-"; }
  alive(): string[] { return [...this.sources].filter(([, s]) => s.alive).map(([id]) => id); }

  enabled(P: number): string[] {
    const ev: string[] = [];
    if (!this.cap) { for (const b of BYTES) ev.push(`open ${b}`); if (this.model.drift) ev.push("open X'"); }
    else {
      if (!this.cap.busy) {
        if (this.model.paste) for (const b of BYTES) ev.push(`paste ${b}`);
        if (this.presses < P) ev.push("press");
      }
      ev.push("cancel");
    }
    if (this.model.form && !this.formBusy && this.presses < P) for (const b of BYTES) ev.push(`form ${b}`);
    for (const r of this.reqs) {
      if (r.srv === "wire") ev.push(`arrive #${r.n}`);
      if (r.srv === "at") ev.push(`commit #${r.n}`, ...this.model.refusals.map((x) => `${x} #${r.n}`));
      if (r.cli === "out" && r.srv === "done") ev.push(`deliver #${r.n}`);
      if (r.cli === "out") ev.push(`lose #${r.n}`);
    }
    for (const b of BYTES) if ([...this.sources.values()].some((s) => s.alive && s.bytes === b)) ev.push(`delete ${b}`);
    return ev;
  }

  answer(r: Req, a: Answer) { r.srv = "done"; r.answer = { ...a, snap: this.alive() }; }

  act(e: string): Judging {
    this.t++;
    this.landings = [];
    const [verb, arg] = e.split(" ");
    const req = arg?.startsWith("#") ? this.reqs[Number(arg.slice(1))] : undefined;
    const before = this.cap ? { ...this.cap } : null;
    const upBefore: string | null = this.cap?.mid ?? null;
    switch (verb) {
      case "open": {
        const mid = `d${this.dialogs++}`, dialog = {}, read = arg.endsWith("'") ? FALLBACK : READ;
        this.tokens.set(dialog, mid);
        this.cap = this.model.step === "captions"
          ? { boardId: "b1", step: "captions", url: TALK, ...read, vtt: "", busy: false, error: "", dialog, mid }
          : { boardId: "b1", step: "url", url: "", vtt: "", busy: false, error: "", dialog, mid };
        this.type(this.text(arg[0] as Bytes));
        break;
      }
      case "paste": {
        this.type("");
        this.type(this.text(arg as Bytes));
        const act = this.acts.get(this.cap.mid);
        if (act && act.bytes !== arg) this.acts.delete(this.cap.mid);
        break;
      }
      case "press": {
        const door: string = this.cap.mid, bytes = this.shown() as Bytes;
        const act = this.acts.get(door)?.bytes === bytes ? this.acts.get(door)! : { bytes, start: this.t };
        this.acts.set(door, act);
        this.presses++;
        this.acting = { door, act, tries: 0 };
        this.pressButton();
        break;
      }
      case "cancel": this.cap = null; break;
      case "form": {
        const bytes = arg as Bytes;
        const act = this.acts.get("form")?.bytes === bytes ? this.acts.get("form")! : { bytes, start: this.t };
        this.acts.set("form", act);
        this.presses++;
        this.formBusy = true;
        this.acting = { door: "form", act, tries: 0 };
        this.C.saveLink("b1", LINK[bytes], this.formDraft).then((said: string) => {
          this.formBusy = false;
          if (said !== "added") return;
          this.formDraft = {};
          this.acts.delete("form");
          const a = this.formAnswer!;
          if (!a.snap!.includes(a.res!)) this.fail(`no ghost: the form says added for ${a.res}, which its own answer's board no longer holds`);
          const s = this.sources.get(a.res!);
          if (s && s.seenAt === Infinity) s.seenAt = this.t;
        }, () => { this.formBusy = false; });
        break;
      }
      case "arrive": {
        const r = req!;
        const had = r.key === undefined ? undefined : this.receipts.get(r.key);
        if (had) {
          if (had.route !== r.route || had.body !== r.body) { this.fail(`no 422: ${e} replays a receipt for ${had.route} ${had.body}`); this.answer(r, { status: 422 }); }
          else this.answer(r, { status: 201, res: had.res });
        } else if (r.key !== undefined && this.reqs.some((o) => o !== r && o.key === r.key && o.srv === "at")) this.answer(r, { status: 409 });
        else r.srv = "at";
        break;
      }
      case "commit": {
        const r = req!, res = `R${this.sources.size}`;
        for (const [id, s] of this.sources) if (s.alive && s.bytes === r.bytes && s.seenAt >= r.act.start)
          this.fail(`one source: ${e} makes a second source of ${r.bytes} while ${id} is held and was not seen before this act began`);
        this.sources.set(res, { bytes: r.bytes, alive: true, seenAt: Infinity });
        if (r.key !== undefined) this.receipts.set(r.key, { route: r.route, body: r.body, res });
        this.answer(r, { status: 201, res });
        break;
      }
      case "5xx": this.answer(req!, { status: 503 }); break;
      case "4xx": this.answer(req!, { status: 400 }); break;
      case "deliver": {
        const r = req!, a = r.answer!;
        r.cli = "settled";
        this.acting = { door: r.door, act: r.act, tries: r.tries + 1 };
        if (r.door === "form") this.formAnswer = a;
        if (a.status === 201) r.ok({
          kind: this.model.step === "captions" ? "transcript" : "article", resourceId: a.res, pairId: `p${a.res}`, cues: 1, title: "A source",
          state: { board: { id: "b1" }, resources: a.snap!.map((id) => ({ id })) },
        });
        else r.no(Object.assign(new Error(`HTTP ${a.status}`), { status: a.status }));
        break;
      }
      case "lose": {
        const r = req!;
        r.cli = "settled";
        this.acting = { door: r.door, act: r.act, tries: r.tries + 1 };
        r.no(new TypeError("Failed to fetch"));
        break;
      }
      case "delete": for (const s of this.sources.values()) if (s.bytes === arg) s.alive = false; break;
      default: throw new Error(`no event ${e}`);
    }
    return { e, req, before, upBefore };
  }
  moving() { return `${this.reqs.length} ${this.sets} ${this.landings.length} ${this.formBusy}`; }
  settle(j: Judging) { this.acting = null; this.judge(j.e, j.req, j.before, j.upBefore); }

  judge(e: string, req: Req | undefined, before: any, upBefore: string | null) {
    const same = (a: any, b: any) => (!a && !b) || (!!a && !!b && ["mid", "step", "url", "vtt", "busy", "error"].every((k) => a[k] === b[k]));
    if (req && (e.startsWith("deliver") || e.startsWith("lose")) && req.door !== upBefore && !same(before, this.cap))
      this.fail(`own dialog: ${e}, an answer to ${req.door}, ${this.cap ? "rewrote" : "closed"} ${upBefore}`);
    for (const l of this.landings) {
      if (l.ghost) this.fail(`no ghost: ${e} lands ${l.res}, which its own answer's board no longer holds`);
      if (l.told && this.toasted.has(l.res)) this.fail(`told once: ${e} tells ${l.res} a second time`);
      if (!l.told && !this.toasted.has(l.res)) this.fail(`told once: ${e} lands ${l.res} in a dialog and nothing ever told it`);
      if (l.told) this.toasted.add(l.res);
    }
    if (req && e.startsWith("deliver") && req.door !== "form" && req.answer!.status === 201 && req.answer!.snap!.includes(req.answer!.res!)) {
      const res = req.answer!.res!;
      if (!this.landings.some((l) => l.res === res)) this.fail(`lands: ${e} answered ${req.door} with ${res}, and nothing landed it`);
      else if (upBefore === req.door) {
        if (this.cap) this.fail(`lands: ${e} landed ${res} and left its dialog ${req.door} open`);
        const s = this.sources.get(res)!;
        if (s.seenAt === Infinity) s.seenAt = this.t;
        this.acts.delete(req.door);
      }
    }
  }

  canon(): string {
    const ids = new Map<string, string>();
    const name = (kind: string, v: string | undefined) => {
      if (v === undefined) return "-";
      const k = `${kind}:${v}`;
      if (!ids.has(k)) ids.set(k, `${kind}${[...ids.keys()].filter((x) => x.startsWith(`${kind}:`)).length}`);
      return ids.get(k)!;
    };
    const K = (k?: string) => name("k", k), D = (d: string) => (d === "form" ? "form" : name("d", d)), R = (r?: string) => name("r", r);
    const live = this.reqs.filter((r) => !(r.cli === "settled" && r.srv === "done"));
    const times = [...new Set([...live.map((r) => r.act.start), ...[...this.acts.values()].map((a) => a.start), ...[...this.sources.values()].map((s) => s.seenAt)])].sort((a, b) => a - b);
    const T = (t: number) => (t === Infinity ? "∞" : times.indexOf(t));
    const out: unknown[] = [];
    const c = this.cap;
    out.push(c ? [D(c.mid), c.step, this.shown(), c.title === FALLBACK.title ? "'" : "", c.busy ? 1 : 0, c.error ? 1 : 0, K(c.draft)] : 0);
    out.push(this.model.form ? [this.formBusy ? 1 : 0, K(this.formDraft.key), this.formDraft.url ? bytesIn(this.formDraft.url) : "-"] : 0);
    out.push(live.map((r) => [D(r.door), r.route, r.body, K(r.key), r.srv, r.cli, T(r.act.start), r.tries,
      r.answer ? [r.answer.status, R(r.answer.res), r.answer.res && !r.answer.snap!.includes(r.answer.res) ? 1 : 0] : 0]));
    out.push([...this.acts].filter(([d]) => d === "form" || d === c?.mid).map(([d, a]) => [D(d), a.bytes, T(a.start)]));
    const peek = this.C.__peek();
    const ser = (v: unknown): unknown => {
      if (typeof v === "string") return /^[0-9a-f]{32}$/.test(v) ? K(v) : v.includes(" ") ? `${v.split(" ")[0]}:${bytesIn(v)}${v.includes(`"title":"${FALLBACK.title}"`) ? "'" : ""}` : v;
      if (typeof v === "function") return ser(v());
      if (v instanceof Map) return [...v].map(([a, b]) => [ser(a), ser(b)]);
      if (v instanceof Set) return [...v].map(ser);
      if (Array.isArray(v)) return v.map(ser);
      if (v && typeof v === "object") return this.tokens.has(v) ? D(this.tokens.get(v)!) : Object.keys(v).length ? Object.entries(v).map(([a, b]) => [a, ser(b)]) : "{}";
      return v;
    };
    out.push(peek.held === undefined ? "?" : ser(peek.held));
    out.push(peek.said === undefined ? "?" : [...(peek.said as Set<string>)].filter((k) => ids.has(`k:${k}`)).map(K).sort());
    out.push([...ids.keys()].filter((x) => x.startsWith("k:")).map((x) => { const r = this.receipts.get(x.slice(2)); return r ? [K(x.slice(2)), r.route, r.body, R(r.res)] : 0; }));
    out.push([...ids.keys()].filter((x) => x.startsWith("r:")).map((x) => { const s = this.sources.get(x.slice(2))!; return [R(x.slice(2)), s.alive ? 1 : 0, T(s.seenAt), this.toasted.has(x.slice(2)) ? 1 : 0]; }));
    out.push([...this.sources].filter(([id, s]) => s.alive && !ids.has(`r:${id}`)).map(([, s]) => `${s.bytes}${T(s.seenAt)}`).sort());
    out.push(this.presses);
    return JSON.stringify(out);
  }
}

export async function run(model: Model, events: string[], P = Infinity, asReported = false): Promise<Walked> {
  return (await runAll(model, [events], P, asReported))[0];
}
async function runAll(model: Model, all: string[][], P = Infinity, asReported = false): Promise<Walked[]> {
  const ws = all.map(() => Object.assign(new World(model), { walked: [] as string[] }) as Walked);
  const at = all.map(() => 0);
  for (;;) {
    const stepping: [Walked, Judging][] = [];
    ws.forEach((w, i) => {
      while (at[i] < all[i].length && !w.bad && !w.invalid) {
        const e = all[i][at[i]++];
        if (!w.enabled(P).includes(e)) {
          const r = /^(commit|5xx|4xx) #(\d+)$/.exec(e);
          if (asReported && r && w.reqs[Number(r[2])]?.srv === "done") continue;
          w.invalid = `"${e}" is not one of the model's events here (${w.enabled(P).join(", ")})`;
          break;
        }
        w.walked.push(e);
        stepping.push([w, w.act(e)]);
        break;
      }
    });
    if (!stepping.length) return ws;
    for (let i = 0; i < FLUSH; i++) await null;
    // nothing may still be moving: a step whose effects outlast the flush would be judged early
    const was = stepping.map(([w]) => w.moving());
    for (let i = 0; i < 4; i++) await null;
    stepping.forEach(([w, j], k) => {
      if (w.moving() !== was[k]) throw new Error(`${j.e} was still moving after ${FLUSH} turns: raise CAPTURE_MODEL_FLUSH`);
      w.settle(j);
    });
  }
}

export interface Found { events: string[]; bad: string }
const BATCH = 1000;
export async function explore(model: Model, N: number, P: number, all = false) {
  // the refusals a search makes are errors by the hundred thousand: their stacks are never read
  const stacks = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try { return await search(model, N, P, all); } finally { Error.stackTraceLimit = stacks; }
}
async function search(model: Model, N: number, P: number, all: boolean) {
  const t0 = Date.now();
  const first = new World(model);
  const children = new Map<string, string[]>();
  const seen = new Set<string>([first.canon()]);
  let frontier = [{ events: [] as string[], c: first.canon(), next: first.enabled(P) }];
  const found: Found[] = [];
  const badKinds = new Set<string>();
  let runs = 0;
  for (let depth = 0; depth < N && frontier.length; depth++) {
    const later: typeof frontier = [];
    const edges = frontier.flatMap((node) => node.next.map((e) => ({ node, events: [...node.events, e] })));
    for (const node of frontier) children.set(node.c, []);
    for (let from = 0; from < edges.length; from += BATCH) {
      const batch = edges.slice(from, from + BATCH);
      const ws = await runAll(model, batch.map((x) => x.events), P);
      runs += ws.length;
      for (const [i, w] of ws.entries()) {
        const { node, events } = batch[i], kids = children.get(node.c)!;
        if (w.invalid) throw new Error(w.invalid);
        if (w.bad) {
          kids.push("bad");
          const kind = w.bad.split(":")[0];
          if (!badKinds.has(kind)) { badKinds.add(kind); found.push({ events, bad: w.bad }); }
          if (!all) return { found, seen, states: seen.size, runs, sequences: 0, ms: Date.now() - t0 };
          continue;
        }
        const c = w.canon();
        kids.push(c);
        if (seen.has(c)) continue;
        seen.add(c);
        later.push({ events, c, next: w.enabled(P) });
      }
    }
    frontier = later;
  }
  const memo = new Map<string, number>();
  const count = (c: string, left: number): number => {
    if (c === "bad" || left === 0 || !children.has(c)) return 1;
    const k = `${left}|${c}`;
    if (!memo.has(k)) memo.set(k, 1 + children.get(c)!.reduce((n, kid) => n + count(kid, left - 1), 0));
    return memo.get(k)!;
  };
  return { found, seen, states: seen.size, runs, sequences: count(first.canon(), N), ms: Date.now() - t0 };
}

export const KNOWN: { name: string; model: Model; events: string[]; fixedBy: string }[] = [
  { name: "a cancelled press's landing closes the next dialog", model: CAPTIONS, fixedBy: "b32681d",
    events: ["open X", "press", "cancel", "open Y", "arrive #0", "commit #0", "deliver #0"] },
  { name: "a cancelled press's refusal is written into the next dialog", model: CAPTIONS, fixedBy: "b32681d",
    events: ["open X", "press", "cancel", "open Y", "press", "lose #0"] },
  { name: "cancelled mid-save and captured again: a second key", model: CAPTIONS, fixedBy: "05efc10",
    events: ["open X", "press", "cancel", "open X", "press", "arrive #0", "commit #0", "arrive #1", "commit #1"] },
  { name: "cleared and pasted again after Failed to fetch: a second key", model: CAPTIONS, fixedBy: "05efc10",
    events: ["open X", "press", "arrive #0", "commit #0", "lose #0", "paste X", "press", "arrive #1", "commit #1"] },
  { name: "the form landed first: the dialog's replay lands nothing", model: LINKS, fixedBy: "2400875",
    events: ["form X", "open X", "press", "arrive #0", "commit #0", "deliver #0", "arrive #1", "deliver #1"] },
  { name: "capture-cancel-lost: the cancelled landing lets go while the next press is out", model: CAPTIONS, fixedBy: "56ec346",
    events: ["open X", "press", "cancel", "open X", "press", "arrive #0", "commit #0", "deliver #0", "arrive #1", "lose #1", "press", "arrive #2", "commit #2"] },
  { name: "a door answered 409 while the form's press of the link lands", model: LINKS, fixedBy: "56ec346",
    events: ["form X", "open X", "press", "arrive #0", "arrive #1", "deliver #1", "commit #0", "deliver #0", "press", "arrive #2", "commit #2"] },
  { name: "capture-cancel-landed: the cancelled landing comes before the next dialog's press", model: CAPTIONS, fixedBy: "d1e6401",
    events: ["open X", "press", "cancel", "open X", "arrive #0", "commit #0", "deliver #0", "press", "arrive #1", "commit #1"] },
  { name: "a lost answer, the source deleted, pressed again: a replay lands a deleted source", model: CAPTIONS, fixedBy: "e003092",
    events: ["open X", "press", "arrive #0", "commit #0", "lose #0", "delete X", "press", "arrive #1", "deliver #1"] },
  { name: "capture-title-drift: the next dialog's title read as oEmbed's fallback, the cancelled landing before its press", model: CAPTIONS, fixedBy: "this change",
    events: ["open X", "press", "cancel", "open X'", "arrive #0", "commit #0", "deliver #0", "press", "arrive #1", "commit #1"] },
  { name: "the next dialog's title read differently while the cancelled press is still out", model: CAPTIONS, fixedBy: "this change",
    events: ["open X", "press", "cancel", "open X'", "press", "arrive #0", "commit #0", "arrive #1", "commit #1"] },
];
export const BOUND = { captions: { N: 13, P: 3 }, link: { N: 11, P: 3 } } as const;

const report = (r: Awaited<ReturnType<typeof explore>>) =>
  r.found.map((f) => `${f.bad}\n    after: ${f.events.join(" · ")}`).join("\n");

if (process.env.CAPTURE_MODEL_SRC) {
  for (const k of KNOWN) {
    const w = await run(k.model, k.events, Infinity, true);
    console.log(`${w.invalid ? "invalid" : w.bad ? "FAILS " : "holds "} ${k.name}${w.bad ? `\n         ${w.bad}` : w.invalid ? `: ${w.invalid}` : ""}`);
  }
  for (const m of [CAPTIONS, LINKS]) {
    const { N, P } = BOUND[m.name as keyof typeof BOUND];
    const r = await explore(m, N, P, ALL);
    console.log(`\n${m.name} model, N=${N} P=${P}: ${r.states} states, ${r.runs} runs, ${r.ms} ms\n${report(r) || "no counterexample"}`);
  }
} else {
  // searched at module top, before any test: node:test follows every await and runs far slower
  const searched: { m: Model; N: number; P: number; r: Awaited<ReturnType<typeof explore>> }[] = [];
  for (const m of [CAPTIONS, LINKS]) {
    const { N, P } = BOUND[m.name as keyof typeof BOUND];
    searched.push({ m, N, P, r: await explore(m, N, P) });
  }
  const walked: { k: (typeof KNOWN)[number]; w: Walked }[] = [];
  for (const k of KNOWN) walked.push({ k, w: await run(k.model, k.events, BOUND[k.model.name as keyof typeof BOUND].P, true) });

  test("the search reads the chunk's own maps, so no two states it merges differ in them", () => {
    const peek = new World(CAPTIONS).C.__peek();
    assert.ok(peek.held instanceof Map && peek.said instanceof Set, "capture-key.ts's held and said are not where PEEK looks: states would be merged blind");
  });
  for (const { m, N, P, r } of searched) {
    test(`the ${m.name} model: every sequence of up to ${N} events and ${P} presses keeps every invariant (${r.states} states standing for ${r.sequences} sequences, ${r.runs} runs, ${r.ms} ms)`, () => {
      assert.equal(r.found.length, 0, report(r));
    });
  }
  test("every ordering the reviews reported is one of the sequences searched, and holds", () => {
    for (const { k, w } of walked) {
      const { N, P } = BOUND[k.model.name as keyof typeof BOUND];
      assert.ok(k.events.length <= N && k.events.filter((e) => e === "press" || e.startsWith("form")).length <= P, `${k.name}: outside the bound`);
      assert.equal(w.invalid, undefined, `${k.name}: ${w.invalid}`);
      assert.equal(w.bad, null, `${k.name}: ${w.bad}`);
      assert.ok(searched.find((s) => s.m === k.model)!.r.seen.has(w.canon()), `${k.name}: the search never reached the state it ends in`);
    }
  });
}
