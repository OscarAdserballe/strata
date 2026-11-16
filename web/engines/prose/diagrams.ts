// Mermaid is large, so it is a lazy chunk fetched only when a source has a chart; one it can't draw keeps its code.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
const loadMermaid = () => (loading ??= import("mermaid").then((m) => {
  m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
  return m.default;
}).catch((e) => { loading = null; throw e; }));

let drawn = 0;

export function drawDiagrams(root: HTMLElement, after?: () => void): void {
  const fences = [...root.querySelectorAll<HTMLElement>('pre[data-lang="mermaid"]:not([data-drawn])')];
  if (!fences.length) return;
  for (const pre of fences) pre.dataset.drawn = "pending";
  void loadMermaid().then(async (mermaid) => {
    let changed = false;
    for (const pre of fences) {
      if (!pre.isConnected) continue;
      try {
        const { svg } = await mermaid.render(`strata-diagram-${++drawn}`, pre.textContent || "");
        if (!pre.isConnected) continue;
        const fig = document.createElement("figure");
        fig.className = "diagram";
        fig.contentEditable = "false";
        fig.innerHTML = svg;
        pre.before(fig);
        pre.dataset.drawn = "yes";
        changed = true;
      } catch { pre.dataset.drawn = "failed"; }
    }
    if (changed) after?.();
  }, () => { for (const pre of fences) pre.dataset.drawn = "failed"; });
}
