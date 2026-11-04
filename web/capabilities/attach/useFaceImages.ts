import { useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import { imageIds, removeImage } from "../../../shared/images/ref.ts";
import { imageSrc } from "../../engines/prose/images.tsx";
import { dragsImages, imagesIn, pasteIntoFace } from "./attach.ts";

export interface FaceImages {
  handlers: {
    onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void;
    onDragOver(e: DragEvent<HTMLTextAreaElement>): void;
    onDrop(e: DragEvent<HTMLTextAreaElement>): void;
  };
  refs: { id: string; src: string }[];
  remove(id: string): void;
  status: string;
}

export function useFaceImages(value: string, set: (next: string) => void): FaceImages {
  const [status, setStatus] = useState("");
  const latest = useRef(value);
  latest.current = value;
  const put = useRef(set);
  put.current = set;
  const face = { value: () => latest.current, set: (v: string) => put.current(v), say: setStatus };
  const refs = useMemo(() => imageIds(value).map((id) => ({ id, src: imageSrc(id) })), [value]);
  return {
    handlers: {
      onPaste: (e) => { if (pasteIntoFace(imagesIn(e.clipboardData), e.currentTarget.selectionStart ?? latest.current.length, face)) e.preventDefault(); },
      // a drop on the face is the face's: not the room's, which would make a source of it
      onDragOver: (e) => { if (dragsImages(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; } },
      onDrop: (e) => {
        if (pasteIntoFace(imagesIn(e.dataTransfer), e.currentTarget.selectionStart ?? latest.current.length, face)) { e.preventDefault(); e.stopPropagation(); }
      },
    },
    refs,
    remove: (id) => put.current(removeImage(latest.current, id)),
    status,
  };
}
