export interface ClaimNode { id: string; label?: string; kind?: string; anchor?: string; questions?: unknown[]; children?: ClaimNode[] }
export interface Claim { id: string; label?: string; kind?: string; anchor?: string; questions: unknown[]; depth: number }
export type TreesBySection = Record<string, { data?: { status?: string; tree?: { nodes?: ClaimNode[] } | null } | null }>;

export function claimsIn(tr: TreesBySection, sections: readonly { id: string }[]): Claim[] {
  const out: Claim[] = [];
  const walk = (ns: ClaimNode[] | undefined, depth: number) => {
    for (const n of ns || []) {
      out.push({ id: n.id, label: n.label, kind: n.kind, anchor: n.anchor, questions: n.questions || [], depth });
      walk(n.children, depth + 1);
    }
  };
  for (const s of sections) {
    const t = (tr[s.id] || {}).data;
    if (!t || t.status !== "ready" || !t.tree) continue;
    walk(t.tree.nodes, 0);
  }
  return out;
}
