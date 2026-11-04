// window.strata inside a live page: the page keeps one JSON value, and the reader around it stores it.

import type { FromPage, ToPage } from "./protocol.ts";
import { PAGE_STATE_MAX } from "../../../shared/reading/page-state.ts";

export interface PageApi {
  load(): Promise<unknown | null>;
  save(value: unknown): Promise<void>;
}

export const LOAD_WAIT = 4000;
export const SAVE_WAIT = 60_000;
const later = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };

/** `send` is null when the page was opened on its own, with no reader around it. */
export function pageApi(send: ((m: FromPage) => void) | null, wait: (fn: () => void, ms: number) => () => void = later) {
  const asked = new Map<number, (m: ToPage | null) => void>();
  let n = 0;
  const ask = (m: (n: number) => FromPage, ms: number): Promise<ToPage | null> => new Promise((done) => {
    const id = ++n;
    const stop = wait(() => { if (asked.delete(id)) done(null); }, ms);
    asked.set(id, (reply) => { stop(); done(reply); });
    send!(m(id));
  });
  const api: PageApi = Object.freeze({
    async load() {
      if (!send) return null;
      const m = await ask((id) => ({ t: "load", n: id }), LOAD_WAIT);
      if (!m || m.t !== "state") return null;
      if (m.why) throw new Error(`Strata couldn't read this page's saved state: ${m.why}`);
      return m.value == null ? null : JSON.parse(m.value) as unknown;
    },
    async save(value: unknown) {
      if (!send) throw new Error("this page keeps its state only when opened in Strata");
      const text = JSON.stringify(value);
      if (text === undefined) throw new Error("save a JSON value: an object, array, string, number, boolean or null");
      if (new TextEncoder().encode(text).length > PAGE_STATE_MAX) throw new Error(`a page keeps at most ${PAGE_STATE_MAX / 1024} KB of state`);
      const m = await ask((id) => ({ t: "save", n: id, value: text }), SAVE_WAIT);
      if (!m || m.t !== "saved") throw new Error("Strata didn't answer the save");
      if (!m.ok) throw new Error(`Strata couldn't save this page's state: ${m.why ?? "unknown reason"}`);
    },
  });
  const hear = (m: ToPage): boolean => {
    if (m.t !== "state" && m.t !== "saved") return false;
    const done = asked.get(m.n);
    asked.delete(m.n);
    done?.(m);
    return true;
  };
  return { api, hear };
}
