// Which build outputs the offline download saves: Mermaid's chunks would double it, so offline a chart shows its code.

const ONLINE_ONLY = /node_modules\/mermaid\//;
export function offlineAssets(metafile) {
  const outs = metafile.outputs;
  const reach = (roots, skip) => {
    const seen = new Set(), todo = [...roots];
    while (todo.length) {
      const p = todo.pop();
      if (seen.has(p) || !outs[p] || skip(p)) continue;
      seen.add(p);
      for (const i of outs[p].imports) if (!i.external) todo.push(i.path);
    }
    return seen;
  };
  const lazy = Object.keys(outs).filter((p) => ONLINE_ONLY.test(outs[p].entryPoint ?? ""));
  const kept = reach(Object.keys(outs).filter((p) => !lazy.includes(p) && !/^dist\/chunks\//.test(p)), (p) => lazy.includes(p));
  const online = reach(lazy, (p) => kept.has(p));
  return Object.keys(outs).filter((p) => !p.endsWith(".map") && !online.has(p));
}
