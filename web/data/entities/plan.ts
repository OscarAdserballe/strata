import type { BoardPlan } from "../../../shared/types/index.ts";
import { store as roomStore, type Store } from "../store.ts";
import { mutate, mutator, type Conflict, type Mutator, type Op } from "../mutate.ts";
import { planKey, type PlanEntity } from "./boards.ts";

// One lane per board's plan: moves are relative, so two quick moves must reach the server in order.

export interface PlanAnswer { plan: BoardPlan & { rev?: number }; rev?: number; id?: string }

export const planLane = (board: string) => `plan:${board}`;

export interface PlanWrite {
  label?: string;
  method: Op["method"];
  path: string;
  body?: unknown;
  /** the page's guess at the plan once this lands, painted at once */
  guess?: (plan: BoardPlan) => BoardPlan;
  /** a whole-document write: sent with If-Match over the plan's rev */
  whole?: boolean;
  /** The same gesture made over theirs after a 409 (default: the same write); null gives up. */
  rebuild?: (theirs: BoardPlan) => PlanWrite | null;
}

const EMPTY: BoardPlan = { purpose: "", groups: [], milestones: [], places: {} };

export const planOps = {
  write(board: string, w: PlanWrite, s: Store = roomStore): Op<PlanAnswer> {
    const key = planKey(board);
    return {
      label: w.label ?? "save that",
      lanes: [planLane(board)],
      method: w.method,
      path: `/api/boards/${board}/plan${w.path}`,
      body: w.body,
      ...(w.whole ? {
        base: () => { const rev = s.entry<PlanEntity>(key)?.base?.rev; return typeof rev === "number" && rev > 0 ? rev : null; },
        takeConflict: { key, fold: (_held: PlanEntity, c: Conflict) => ({ ...(c.value as BoardPlan), rev: c.rev }) },
        onConflict: (c: Conflict) => {
          // over the plan the store holds once it has taken the refusal: theirs, or a newer one read first
          const theirs = s.entry<PlanEntity>(key)?.base ?? c.value as BoardPlan;
          const next = w.rebuild ? w.rebuild(theirs) : w;
          return next ? planOps.write(board, next, s) : null;
        },
      } : {}),
      ...(w.guess ? { optimistic: [{ key, apply: (held: PlanEntity | undefined) => ({ ...(w.guess!(held ?? { ...EMPTY, rev: 0 }) as PlanEntity), rev: held?.rev ?? 0 }) }] } : {}),
      flush: true,
    };
  },
};

export const plan = {
  write: (board: string, w: PlanWrite) => mutate(planOps.write(board, w)),
  /** Gives up a failed write so the server's plan shows and the next write is sent. */
  abandon: (board: string, m: Mutator = mutator) => m.discardFailed(planLane(board)),
};

type Place = BoardPlan["places"][string];
const NO_PLACE: Place = { group: null, milestone: null, pinned: false, ord: null };
type PlacePatch = Partial<Place>;
type GroupPatch = Partial<BoardPlan["groups"][number]>;
type MilestonePatch = Partial<Omit<BoardPlan["milestones"][number], "doneAt">> & { move?: number; done?: boolean };

/** A group's whole order; after a 409: your order first, then what the other device added since. */
export function planOrder(gid: string, items: string[]): PlanWrite {
  return {
    method: "PUT", path: "/order", body: { group: gid, items }, whole: true,
    guess: (p) => {
      const places = { ...p.places };
      items.forEach((it, i) => { places[it] = { ...NO_PLACE, ...places[it], group: gid, ord: i }; });
      return { ...p, places };
    },
    rebuild: (theirs) => {
      const added = Object.entries(theirs.places || {})
        .filter(([it, pl]) => pl && pl.group === gid && !items.includes(it))
        .sort((a, b) => (a[1].ord ?? Infinity) - (b[1].ord ?? Infinity))
        .map(([it]) => it);
      return planOrder(gid, [...items, ...added]);
    },
  };
}

const unplace = (p: BoardPlan, field: "group" | "milestone", id: string): BoardPlan["places"] =>
  Object.fromEntries(Object.entries(p.places).map(([k, v]) =>
    [k, v[field] !== id ? v : field === "group" ? { ...v, group: null, ord: null } : { ...v, milestone: null }]));

export const planGestures = {
  purpose: (v: string): PlanWrite => ({ method: "PUT", path: "/purpose", body: { purpose: v }, whole: true, guess: (p) => ({ ...p, purpose: v.trim() }) }),
  addGroup: (): PlanWrite => ({ method: "POST", path: "/groups", body: { name: "New group" } }),
  group: (gid: string, patch: GroupPatch = {}): PlanWrite => ({
    method: "PATCH", path: `/groups/${gid}`, body: patch,
    guess: (p) => ({ ...p, groups: p.groups.map((g) => (g.id === gid ? { ...g, ...patch } : g)) }),
  }),
  delGroup: (gid: string): PlanWrite => ({
    method: "DELETE", path: `/groups/${gid}`,
    guess: (p) => ({ ...p, groups: p.groups.filter((g) => g.id !== gid), places: unplace(p, "group", gid) }),
  }),
  addMilestone: (): PlanWrite => ({ method: "POST", path: "/milestones", body: { name: "New milestone" } }),
  milestone: (mid: string, patch: MilestonePatch = {}): PlanWrite => ({
    method: "PATCH", path: `/milestones/${mid}`, body: patch,
    guess: (p) => {
      const ms = p.milestones.slice(), i = ms.findIndex((m) => m.id === mid);
      if (i < 0) return p;
      const { move, done, ...rest } = patch;
      ms[i] = { ...ms[i], ...rest, ...(done === undefined ? {} : { doneAt: done ? Date.now() : null }) };
      const j = i + (move || 0);
      if (move && j >= 0 && j < ms.length) [ms[i], ms[j]] = [ms[j], ms[i]];
      return { ...p, milestones: ms };
    },
  }),
  delMilestone: (mid: string): PlanWrite => ({
    method: "DELETE", path: `/milestones/${mid}`,
    guess: (p) => ({ ...p, milestones: p.milestones.filter((m) => m.id !== mid), places: unplace(p, "milestone", mid) }),
  }),
  order: planOrder,
  place: (item: string, patch: PlacePatch = {}): PlanWrite => ({
    method: "PATCH", path: `/places/${encodeURIComponent(item)}`, body: patch,
    guess: (p) => ({ ...p, places: { ...p.places, [item]: { ...NO_PLACE, ...p.places[item], ...patch } } }),
  }),
};

/** The plan rail's calls for one board; the two adds resolve with the new id, or null on failure. */
export function planCalls(write: (w: PlanWrite) => Promise<PlanAnswer | null>) {
  const g = planGestures;
  const idOf = (r: PlanAnswer | null) => (r ? r.id ?? null : null);
  return {
    purpose: (v: string) => write(g.purpose(v)),
    addGroup: () => write(g.addGroup()).then(idOf),
    group: (gid: string, patch?: GroupPatch) => write(g.group(gid, patch)),
    delGroup: (gid: string) => write(g.delGroup(gid)),
    addMilestone: () => write(g.addMilestone()).then(idOf),
    milestone: (mid: string, patch?: MilestonePatch) => write(g.milestone(mid, patch)),
    delMilestone: (mid: string) => write(g.delMilestone(mid)),
    order: (gid: string, items: string[]) => write(g.order(gid, items)),
    place: (item: string, patch?: PlacePatch) => write(g.place(item, patch)),
  };
}
