const SMALL = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "my", "some", "let's", "lets", "can", "we", "i", "is", "it"]);
/** A Dispatch rail square's two letters: the initials of the title's first two words that say something. */
export function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  const said = words.filter((w) => !SMALL.has(w.toLowerCase()));
  const two = (said.length >= 2 ? said : words).slice(0, 2);
  return (two.length === 1 ? two[0].slice(0, 2) : two.map((w) => w[0]).join("")).toUpperCase() || "·";
}
