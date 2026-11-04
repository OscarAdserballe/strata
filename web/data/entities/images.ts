import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";

export interface StoredImage { id: string; mime: string; w: number; h: number; size: number }

let seq = 0;

export const imageOps = {
  upload(data: string): Op<{ image: StoredImage }> {
    return {
      label: "upload that image",
      // a lane per paste, so two screenshots upload side by side and neither waits on the other
      lanes: [`image:${++seq}`],
      method: "POST",
      path: "/api/images",
      body: { data },
    };
  },
};

export const images = {
  upload: (data: string, m: Mutator = roomMutator): Promise<StoredImage> => m.release(imageOps.upload(data)).then((r) => r.image),
};
