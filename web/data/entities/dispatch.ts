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

export const dispatchOps = {
  /** Go or Send back: the card leaves Decide or Review at once and waits in Implementing. */
  press(id: string, kind: "go" | "back", now: () => number = Date.now, s: Store = roomStore): Op<{ press: unknown; pane: DispatchPane }> {
    return {
      label: kind === "go" ? "send Go" : "send it back",
      lanes: [`dispatch:${id}`],
      method: "POST",
      path: `/api/dashboard/tasks/${id}/press`,
      body: { kind },
      optimistic: [{ key: DISPATCH_KEY, apply: (v: DispatchPane | undefined) => v && { ...v, threads: v.threads.map((t) => t.id !== id ? t : {
        ...t, stage: "implementing", lands: kind === "back" ? t.stage : t.stage === "review" ? "done" : "review",
        press: { kind, stage: t.stage, version: t.versions.length ? t.versions[t.versions.length - 1].n : null, at: now(), sessionUrl: t.press?.sessionUrl ?? null } }) } }],
      // a dashboard write leaves the room's revision where it was, so the answer carries the pane, ordered by its own rev:
      // a replayed answer to a resent press is older than a later press's and is dropped
      confirm: (res, meta) => { if (res?.pane) s.apply(DISPATCH_KEY, res.pane.rev, res.pane, "wire", { epoch: meta.epoch, stamp: meta.rev }); },
    };
  },
};

export const dispatch = {
  press: (id: string, kind: "go" | "back") => mutate(dispatchOps.press(id, kind)),
};
