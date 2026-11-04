// Generated trees have one synthesis root; drawings show it as a band above the pillars instead.

export interface Rooted<N> { root: N | null; pillars: N[] }

export function liftSynthesis<N extends { kind?: string | null; children?: N[] }>(roots: N[]): Rooted<N> {
  if (roots.length !== 1) return { root: null, pillars: roots };
  const only = roots[0];
  const kids = only.children || [];
  if (only.kind !== "synthesis" || !kids.length) return { root: null, pillars: roots };
  return { root: only, pillars: kids };
}
