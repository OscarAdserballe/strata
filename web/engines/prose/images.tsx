import React from "react";
import { imageParts } from "../../../shared/images/ref.ts";

export const imageSrc = (id: string): string => {
  const base = typeof window !== "undefined" && window.STRATA_BASE ? window.STRATA_BASE : "/";
  return `${base}api/images/${id}`;
};

export const imagesInMarkdown = (md: string): string =>
  md.includes("](img:") ? md.replace(/\]\(img:([0-9a-f]{16})\)/g, (_all, id: string) => `](${imageSrc(id)})`) : md;

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
