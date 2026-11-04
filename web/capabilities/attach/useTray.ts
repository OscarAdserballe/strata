import { useCallback, useEffect, useRef, useState } from "react";
import { imageSrc } from "../../engines/prose/images.tsx";
import { uploadImage } from "./attach.ts";
import { IMAGE_MAX_PER_MESSAGE } from "../../../shared/images/ref.ts";

export interface TrayItem {
  key: number;
  src: string;
  id: string | null;
  error: string;
  pending: Promise<string>;
}

let seq = 0;

export interface Tray {
  items: TrayItem[];
  add(files: File[]): void;
  restore(ids: string[]): void;
  remove(key: number): void;
  clear(): void;
  ids(): Promise<string[]>;
  note: string;
}

export function useTray(): Tray {
  const [items, setItems] = useState<TrayItem[]>([]);
  const [note, setNote] = useState("");
  const live = useRef(items);
  live.current = items;
  const patch = (key: number, p: Partial<TrayItem>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));
  // a blob: URL lives until it is let go
  const revoke = (i: TrayItem) => { if (i.src.startsWith("blob:")) URL.revokeObjectURL(i.src); };
  useEffect(() => () => { for (const i of live.current) revoke(i); }, []);

  const add = useCallback((files: File[]) => {
    const room = IMAGE_MAX_PER_MESSAGE - live.current.length;
    setNote(files.length > room ? `a question can carry ${IMAGE_MAX_PER_MESSAGE} images` : "");
    const fresh = files.slice(0, Math.max(0, room)).map((f): TrayItem => {
      const key = ++seq;
      // uploads start on arrival, so by the time the question is typed they are usually in
      const pending = uploadImage(f).then(
        (img) => { patch(key, { id: img.id }); return img.id; },
        (e: Error | null) => { const why = e?.message || "the upload failed"; patch(key, { error: why }); throw new Error(`couldn't attach an image — ${why}`); },
      );
      pending.catch(() => {});
      return { key, src: URL.createObjectURL(f), id: null, error: "", pending };
    });
    if (fresh.length) setItems((list) => [...list, ...fresh]);
  }, []);
  const restore = useCallback((ids: string[]) => {
    setItems(ids.map((id) => ({ key: ++seq, src: imageSrc(id), id, error: "", pending: Promise.resolve(id) })));
  }, []);
  const remove = useCallback((key: number) => {
    setItems((list) => { for (const i of list) if (i.key === key) revoke(i); return list.filter((i) => i.key !== key); });
    setNote("");
  }, []);
  const clear = useCallback(() => { setItems((list) => { for (const i of list) revoke(i); return []; }); setNote(""); }, []);
  const ids = useCallback(() => Promise.all(live.current.map((i) => i.pending)), []);
  return { items, add, restore, remove, clear, ids, note };
}
