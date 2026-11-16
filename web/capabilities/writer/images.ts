const ROOM = /^(?:img:|(?:.*\/)?api\/images\/)([0-9a-f]{16})$/;

/** `img:<id>` for one of the room's stored images, by its Markdown ref or its URL; null for anything else. */
export function imageRefOf(src: string | null | undefined): string | null {
  const m = src ? ROOM.exec(src) : null;
  return m ? `img:${m[1]}` : null;
}

/** Where the field draws an image from: the room's URL for a stored one, the link itself otherwise. */
export function shownSrc(src: string | null | undefined, roomUrl: (id: string) => string): string | null {
  return src?.startsWith("img:") ? roomUrl(src.slice(4)) : src ?? null;
}
