import { mutate, type Op } from "../mutate.ts";
import { store as roomStore, useQuery, type Fetcher, type Store } from "../store.ts";
import { fetched } from "../api.ts";

export interface DispatchLink { kind: string; ref: string; title?: string; url?: string }
export interface DispatchVersion { n: number; resourceId: string; at: number; landed: string; notes: number }
export interface DispatchPress { kind: string; stage: string; version: number | null; at: number; sessionUrl: string | null }
export interface DispatchThread {
  id: string; title: string; stage: string; links: DispatchLink[]; updatedAt: number;
  versions: DispatchVersion[]; press: DispatchPress | null; lands: string | null;
}
export interface DispatchPane { rev: number; board: string | null; inbox: number; threads: DispatchThread[] }

export const DISPATCH_KEY = "dispatch";
export const dispatchRead: Fetcher<DispatchPane> = () => fetched<DispatchPane>("/api/dashboard/dispatch", (v) => v.rev);
export const useDispatch = (): DispatchPane | undefined => useQuery<DispatchPane>(DISPATCH_KEY, dispatchRead, { tags: [DISPATCH_KEY] });


export interface DashLink { kind: string; ref: string; title?: string; url?: string }
export interface DashFrom { source: string; url?: string; quote?: string }
export interface DashTask {
  id: string; title: string; body: string; stage: string; morningAt: number | null;
  links: DashLink[]; createdFrom: DashFrom | null; createdAt: number; updatedAt: number; clearedAt: number | null;
  area: string; dispatched: boolean;
  updates: { id: string; at: number; text: string; from: DashFrom | null; links: DashLink[] }[];
}
export interface DashItem { id: string; at: number; kind: string; title: string; context?: string; body?: string; area: string; from?: DashFrom; links?: DashLink[] }
export interface DashBoard { rev: number; tasks: DashTask[]; inbox: DashItem[]; archived: number; links: { label: string; url: string }[] }
export interface RoutineView { connected: boolean; url: string | null; ranAt: number | null; sessionUrl: string | null; error: string | null }

export const DASH_KEY = "dashboard";
export const ARCHIVE_KEY = "dashboard-archive";
export const ROUTINE_KEY = "dashboard-routine";
const boardRead: Fetcher<DashBoard> = () => fetched<DashBoard>("/api/dashboard", (v) => v.rev);
const archiveRead: Fetcher<{ tasks: DashTask[] }> = () => fetched<{ tasks: DashTask[] }>("/api/dashboard/archive");
const routineRead: Fetcher<RoutineView> = () => fetched<RoutineView>("/api/dashboard/routine");
export const useDashBoard = (): DashBoard | undefined => useQuery<DashBoard>(DASH_KEY, boardRead, { tags: [DASH_KEY] });
export const useArchive = (on: boolean): DashTask[] | null => {
  const v = useQuery<{ tasks: DashTask[] }>(on ? ARCHIVE_KEY : "dashboard-archive-off", on ? archiveRead : async () => ({ value: { tasks: [] }, rev: 0, epoch: "", origin: "wire", stamp: 0 }), { tags: [ARCHIVE_KEY] });
  return on ? v?.tasks ?? null : null;
};
export const useRoutine = (): RoutineView | undefined => useQuery<RoutineView>(ROUTINE_KEY, routineRead, { tags: [ROUTINE_KEY] });

/** A write's answer carries the board and the pane as they now are, each under the dashboard's own revision. */
export interface DashAnswer { board?: DashBoard; pane?: DispatchPane }
export function takeState(res: DashAnswer | null | undefined, meta: { epoch: string; rev: number }, s: Store = roomStore): void {
  s.batch(() => {
    if (res?.board) s.apply(DASH_KEY, res.board.rev, res.board, "wire", { epoch: meta.epoch, stamp: meta.rev });
    if (res?.pane) s.apply(DISPATCH_KEY, res.pane.rev, res.pane, "wire", { epoch: meta.epoch, stamp: meta.rev });
  });
}

const onTasks = (id: string, fn: (t: DashTask) => DashTask | null) => (v: DashBoard | undefined) => v && {
  ...v, tasks: v.tasks.flatMap((t) => { if (t.id !== id) return [t]; const n = fn(t); return n ? [n] : []; }),
};
const lane = (id: string) => `dash:${id}`;

export const dashOps = {
  keep(id: string, stage: "backlog" | "todo", area: string, s: Store = roomStore): Op<DashAnswer> {
    return { label: "keep that item", lanes: [lane(id)], method: "POST", path: `/api/dashboard/inbox/${id}/keep`, body: { stage, area },
      optimistic: [{ key: DASH_KEY, apply: (v: DashBoard | undefined) => v && { ...v, inbox: v.inbox.filter((i) => i.id !== id) } }],
      confirm: (res, meta) => takeState(res, meta, s) };
  },
  drop(id: string, s: Store = roomStore): Op<DashAnswer> {
    return { label: "drop that item", lanes: [lane(id)], method: "POST", path: `/api/dashboard/inbox/${id}/drop`, body: {},
      optimistic: [{ key: DASH_KEY, apply: (v: DashBoard | undefined) => v && { ...v, inbox: v.inbox.filter((i) => i.id !== id) } }],
      confirm: (res, meta) => takeState(res, meta, s) };
  },
  itemArea(id: string, area: string, s: Store = roomStore): Op<DashAnswer> {
    return { label: "move that item", lanes: [lane(id)], method: "PATCH", path: `/api/dashboard/inbox/${id}`, body: { area },
      optimistic: [{ key: DASH_KEY, apply: (v: DashBoard | undefined) => v && { ...v, inbox: v.inbox.map((i) => (i.id === id ? { ...i, area } : i)) } }],
      confirm: (res, meta) => takeState(res, meta, s) };
  },
  create(task: { id: string; title: string; area: string; stage?: string; links?: DashLink[] }, now = Date.now(), s: Store = roomStore): Op<DashAnswer> {
    const t: DashTask = { id: task.id, title: task.title, body: "", stage: task.stage ?? "backlog", morningAt: null, links: task.links ?? [],
      createdFrom: { source: "You" }, createdAt: now, updatedAt: now, clearedAt: null, area: task.area, dispatched: false, updates: [] };
    return { label: "add that thread", lanes: [lane(task.id)], method: "POST", path: "/api/dashboard/tasks", body: { ...task, stage: t.stage },
      optimistic: [{ key: DASH_KEY, apply: (v: DashBoard | undefined) => v && { ...v, tasks: [...v.tasks.filter((x) => x.id !== t.id), t] } }],
      confirm: (res, meta) => takeState(res, meta, s) };
  },
  /** Any change to a thread's fields; `local` is how it looks until the server answers. Done and dropped leave the board. */
  patch(id: string, body: Record<string, unknown>, local: (t: DashTask) => DashTask | null, s: Store = roomStore): Op<DashAnswer> {
    return { label: "save that thread", lanes: [lane(id)], method: "PATCH", path: `/api/dashboard/tasks/${id}`, body,
      optimistic: [{ key: DASH_KEY, apply: onTasks(id, local) }],
      confirm: (res, meta) => takeState(res, meta, s) };
  },
  /** The doc's title and notes as typed: only the newest unsent text goes. */
  text(id: string, field: "title" | "body", value: string, s: Store = roomStore): Op<DashAnswer> {
    return { label: "save those notes", lanes: [lane(id)], coalesce: `dash:${id}:${field}`, method: "PATCH", path: `/api/dashboard/tasks/${id}`, body: { [field]: value },
      optimistic: [{ key: DASH_KEY, apply: onTasks(id, (t) => ({ ...t, [field]: value })) }],
      confirm: (res, meta) => takeState(res, meta, s), flush: true };
  },
  send(id: string, s: Store = roomStore): Op<DashAnswer> {
    return { label: "send that to Dispatch", lanes: [lane(id)], method: "POST", path: `/api/dashboard/tasks/${id}/send`, body: {},
      optimistic: [{ key: DASH_KEY, apply: onTasks(id, (t) => ({ ...t, stage: "implementing", dispatched: true, morningAt: null })) }],
      confirm: (res, meta) => takeState(res, meta, s) };
  },
  routine(body: Record<string, unknown>, s: Store = roomStore): Op<RoutineView> {
    return { label: "save the routine", lanes: [ROUTINE_KEY], method: "PUT", path: "/api/dashboard/routine", body,
      confirm: (res) => { s.apply(ROUTINE_KEY, Date.now(), res, "wire", {}); } };
  },
  runRoutine(s: Store = roomStore): Op<RoutineView> {
    return { label: "run the routine", lanes: [ROUTINE_KEY], method: "POST", path: "/api/dashboard/routine/run", body: {},
      confirm: (res) => { s.apply(ROUTINE_KEY, Date.now(), res, "wire", {}); } };
  },
  /** Go or Send back: the card leaves Decide or Review at once and waits in Implementing. */
  press(id: string, kind: "go" | "back", now: () => number = Date.now, s: Store = roomStore): Op<DashAnswer & { press: unknown }> {
    return {
      label: kind === "go" ? "send Go" : "send it back",
      lanes: [`dispatch:${id}`],
      method: "POST",
      path: `/api/dashboard/tasks/${id}/press`,
      body: { kind },
      optimistic: [{ key: DISPATCH_KEY, apply: (v: DispatchPane | undefined) => v && { ...v, threads: v.threads.map((t) => t.id !== id ? t : {
        ...t, stage: "implementing", lands: kind === "back" ? t.stage : t.stage === "review" ? "done" : "review",
        press: { kind, stage: t.stage, version: t.versions.length ? t.versions[t.versions.length - 1].n : null, at: now(), sessionUrl: t.press?.sessionUrl ?? null } }) } }],
      // a replayed answer to a resent press is older than a later press's, and its revision says so
      confirm: (res, meta) => takeState(res, meta, s),
    };
  },
};

export const dash = {
  keep: (id: string, stage: "backlog" | "todo", area: string) => mutate(dashOps.keep(id, stage, area)),
  drop: (id: string) => mutate(dashOps.drop(id)),
  itemArea: (id: string, area: string) => mutate(dashOps.itemArea(id, area)),
  create: (t: Parameters<typeof dashOps.create>[0]) => mutate(dashOps.create(t)),
  patch: (id: string, body: Record<string, unknown>, local: (t: DashTask) => DashTask | null) => mutate(dashOps.patch(id, body, local)),
  text: (id: string, field: "title" | "body", value: string) => mutate(dashOps.text(id, field, value)),
  send: (id: string) => mutate(dashOps.send(id)),
  routine: (body: Record<string, unknown>) => mutate(dashOps.routine(body)),
  runRoutine: () => mutate(dashOps.runRoutine()),
  press: (id: string, kind: "go" | "back") => mutate(dashOps.press(id, kind)),
};
