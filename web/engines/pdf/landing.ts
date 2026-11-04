// A chapter's first claims sit above its first page; land above them.
export const pageTop = (el: HTMLElement): number => {
  const lead = el.previousElementSibling as HTMLElement | null;
  return Math.max(0, (lead && lead.classList.contains("clm") ? lead.offsetTop : el.offsetTop) - 2);
};
