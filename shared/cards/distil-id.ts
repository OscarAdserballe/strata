/** FNV-1a over the sorted refs: the same marks are the same idea, so a second map, or a merge on either side, keeps one id. */
export function ideaId(refs: readonly string[]): string {
  const text = [...refs].sort().join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return "i" + (h >>> 0).toString(16).padStart(8, "0");
}
