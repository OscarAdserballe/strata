import React from "react";
import { imageParts } from "../../../shared/images/ref.ts";
import { imageSrc } from "./image-src.ts";

export { imageSrc, imagesInMarkdown } from "./image-src.ts";

export const imgProps = { className: "strata-img", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer" } as const;

export function Img({ id, alt }: { id: string; alt: string }) {
  return <img {...imgProps} src={imageSrc(id)} alt={alt || "image"} />;
}

export function withImages(text: string, draw: (t: string, key: string) => React.ReactNode): React.ReactNode[] {
  if (!text.includes("](img:")) return [draw(text, "t")];
  return imageParts(text).map((p, i) => ("id" in p
    ? <Img key={"img" + i} id={p.id} alt={p.alt} />
    : <React.Fragment key={"t" + i}>{draw(p.text, "t" + i)}</React.Fragment>));
}
