import { type DragEvent, useSyncExternalStore } from "react";
import { addSource } from "./AddSource.tsx";
import { attachToAsk } from "../ask/control.ts";
import { isImageFile } from "../../../shared/images/ref.ts";

// drag state lives here, so a drag in and out renders the drop line and not the room

export const hasFiles = (e: { dataTransfer: DataTransfer | null }) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");
// a screenshot is not a source: an image-only drag goes to the Ask's tray, not "drop to add"
const onlyImages = (items: DataTransferItemList | File[] | null | undefined): boolean => {
  const all: { kind?: string; type: string }[] = items ? Array.from(items as ArrayLike<{ kind?: string; type: string }>) : [];
  return all.length > 0 && all.every((i) => (i.kind === undefined || i.kind === "file") && isImageFile(i));
};

let over = false;
const heard = new Set<() => void>();
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
const hover = (on: boolean) => { if (on === over) return; over = on; for (const cb of [...heard]) cb(); };
const now = () => over;

export interface FilesDrop { onDragOver(e: DragEvent): void; onDragLeave(e: DragEvent): void; onDrop(e: DragEvent): void }

export function filesDrop(within: () => HTMLElement | null, board: () => string | null): FilesDrop {
  return {
    onDragOver: (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!onlyImages(e.dataTransfer.items)) hover(true); },
    onDragLeave: (e) => { const el = within(); if (!e.relatedTarget || !(el && el.contains(e.relatedTarget as Node))) hover(false); },
    onDrop: (e) => {
      hover(false); if (!hasFiles(e)) return; e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (onlyImages(files) && attachToAsk(files)) return;
      void addSource.files(files, board());
    },
  };
}

export function DropZone() {
  const on = useSyncExternalStore(subscribe, now, now);
  return on ? <div className="dropzone">drop to add — one source or a whole course</div> : null;
}
