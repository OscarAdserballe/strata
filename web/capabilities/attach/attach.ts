import { images, type StoredImage } from "../../data/entities/images.ts";
import { imageRef, isImageFile } from "../../../shared/images/ref.ts";

export function imagesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files || []).filter(isImageFile);
  if (files.length) return files;
  // some browsers put a pasted screenshot only in `items`
  return Array.from(data.items || [])
    .filter((i) => i.kind === "file" && isImageFile(i))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

// dragover cannot read the files themselves, only their types
export const dragsImages = (data: DataTransfer | null): boolean =>
  !!data && Array.from(data.items || []).some((i) => i.kind === "file" && isImageFile(i));

// the shrinking is a chunk of its own, fetched by the first paste: a session that never pastes never loads it
let shrinker: Promise<typeof import("../../engines/image/shrink.ts")> | null = null;
const loadShrink = () => (shrinker ??= import("../../engines/image/shrink.ts").catch((e) => { shrinker = null; throw e; }));

export async function uploadImage(file: Blob): Promise<StoredImage> {
  const { shrinkImage, base64Of } = await loadShrink();
  const small = await shrinkImage(file);
  return images.upload(await base64Of(small.blob));
}

export interface FaceTarget {
  // read fresh: the text may have changed while the upload was out
  value(): string;
  set(next: string): void;
  say(status: string): void;
}

export function insertRef(text: string, at: number, ref: string): string {
  const pos = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, pos), after = text.slice(pos);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after && !after.startsWith("\n") ? "\n" : "";
  return before + lead + ref + trail + after;
}

// false when nothing was an image, so the textarea takes the paste as it always did
export function pasteIntoFace(files: File[], caret: number, face: FaceTarget): boolean {
  if (!files.length) return false;
  face.say(files.length === 1 ? "uploading image…" : `uploading ${files.length} images…`);
  void (async () => {
    let at = caret;
    for (const f of files) {
      try {
        const img = await uploadImage(f);
        const ref = imageRef(img.id);
        const next = insertRef(face.value(), at, ref);
        at = next.indexOf(ref, Math.max(0, at - 1)) + ref.length + 1;
        face.set(next);
      } catch (e) {
        face.say(`couldn't attach that image — ${(e as Error | null)?.message || "try again"}`);
        return;
      }
    }
    face.say("");
  })();
  return true;
}
