export const imageSrc = (id: string): string => {
  const base = typeof window !== "undefined" && window.STRATA_BASE ? window.STRATA_BASE : "/";
  return `${base}api/images/${id}`;
};

export const imagesInMarkdown = (md: string): string =>
  md.includes("](img:") ? md.replace(/\]\(img:([0-9a-f]{16})\)/g, (_all, id: string) => `](${imageSrc(id)})`) : md;
