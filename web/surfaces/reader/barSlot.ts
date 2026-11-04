// A place in the reader's bar that the reader surface draws into, so what it shows there stays the surface's state.

let slot: HTMLElement | null = null;
const heard = new Set<() => void>();

export const barSlot = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => heard.delete(cb); },
  get: (): HTMLElement | null => slot,
  set(el: HTMLElement | null): void {
    if (el === slot) return;
    slot = el;
    for (const cb of [...heard]) cb();
  },
};
