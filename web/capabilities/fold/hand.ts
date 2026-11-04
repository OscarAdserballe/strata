// The slots in the sheets where card faces are drawn. A sheet is plain DOM, a card's face is React (maths,
// options), so the reader portals each face into whatever slot the last paint left for it.

let slots: ReadonlyMap<string, HTMLElement> = new Map();
const heard = new Set<() => void>();

export const handSlot = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => heard.delete(cb); },
  get: (): ReadonlyMap<string, HTMLElement> => slots,
  /** called after every paint: a sheet rebuilt under a card gives it a new slot */
  find(root: ParentNode | null): void {
    const next = new Map<string, HTMLElement>();
    for (const el of root?.querySelectorAll<HTMLElement>(".fi-face[data-face]") ?? []) next.set(el.dataset.face || "", el);
    if (next.size === slots.size && [...next].every(([k, el]) => slots.get(k) === el)) return;
    slots = next;
    for (const cb of [...heard]) cb();
  },
};
