// The slots in ask folds where answers are drawn. The fold is plain DOM, an answer is markdown with maths
// (React), so the reader portals each answer into whatever slot the last paint left.

export interface SaySlot { key: string; el: HTMLElement; text: string; streaming: boolean }

let slots: readonly SaySlot[] = [];
const heard = new Set<() => void>();
const same = (a: readonly SaySlot[], b: readonly SaySlot[]) =>
  a.length === b.length && a.every((s, i) => s.el === b[i].el && s.text === b[i].text && s.streaming === b[i].streaming);

export const says = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => heard.delete(cb); },
  get: (): readonly SaySlot[] => slots,
  /** called after every paint, with each slot's text by its key */
  find(root: ParentNode | null, text: (key: string) => string | null): void {
    const next: SaySlot[] = [];
    for (const el of root?.querySelectorAll<HTMLElement>(".fi-say[data-say]") ?? []) {
      const key = el.dataset.say!, t = text(key);
      if (t !== null) next.push({ key, el, text: t, streaming: key.endsWith(":w") });
    }
    if (same(next, slots)) return;
    slots = next;
    for (const cb of [...heard]) cb();
  },
};
