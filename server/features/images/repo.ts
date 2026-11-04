import { stmt } from "../../platform/db/sql.ts";

export interface ImageMeta { id: string; mime: string; w: number; h: number; size: number }

export const imagesRepo = {
  /* INSERT OR IGNORE: the id is the bytes' hash, so a row that is there already IS this image */
  insImage: stmt("INSERT OR IGNORE INTO images (id,mime,w,h,size,bytes,created_at) VALUES (?,?,?,?,?,?,?)"),
  imageMeta: stmt<ImageMeta>("SELECT id,mime,w,h,size FROM images WHERE id = ?"),
  imageBytes: stmt<{ mime: string; bytes: Uint8Array }>("SELECT mime, bytes FROM images WHERE id = ?"),
};
