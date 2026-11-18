// Whether the open source shows its primer over its pages: the reader's toggle, held here rather than at the room's root.

let open = false;
const heard = new Set<() => void>();

export const primerPanel = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => heard.delete(cb); },
  get: (): boolean => open,
  set(on: boolean): void {
    if (on === open) return;
    open = on;
    for (const cb of [...heard]) cb();
  },
};
