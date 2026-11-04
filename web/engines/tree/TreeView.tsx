import { useEffect, useState } from "react";
import type { TreeNode, TreeResponse } from "../../../shared/types/index.ts";
import { liftSynthesis } from "./tree.ts";

interface TreeCard { node?: unknown }
type Open = Record<string, boolean>;

interface RowProps<C extends TreeCard> {
  node: TreeNode;
  cardsByNode: Map<unknown, C[]>;
  onAnchor: (anchor: string) => void;
  onCards: (card: C) => void;
  open: Open;
  onToggle: (id: string) => void;
}

export function TreeNodeRow<C extends TreeCard>({ node, cardsByNode, onAnchor, onCards, open, onToggle }: RowProps<C>) {
  const kids = node.children || [];
  const qs = node.questions || [];
  const mine = cardsByNode.get(node.id) || [];
  const isOpen = !!open[node.id];
  const inside = kids.length + qs.length;
  return (
    <li className={"tnode" + (isOpen ? " open" : "")}>
      <div className="trow">
        <div className="tclaim" onClick={() => inside && onToggle(node.id)} title={inside ? (isOpen ? "close" : "open") : undefined}>
          <span className={"ttw" + (inside ? "" : " leaf")}>{inside ? (isOpen ? "▾" : "▸") : "·"}</span>
          {node.kind && node.kind !== "concept" ? <span className={"tkind k-" + node.kind}>{node.kind}</span> : null}
          <span className="tlabel" title={node.excerpt || undefined}>{node.label}</span>
          {!isOpen && inside
            ? <span className="tinside">{kids.length ? `${kids.length} under` : ""}{kids.length && qs.length ? " · " : ""}{qs.length ? `${qs.length} q` : ""}</span>
            : null}
        </div>
        <div className="tmarks">
          {mine.length
            ? <button className="tcards" onClick={() => onCards(mine[0])}
                title={mine.length + " card" + (mine.length > 1 ? "s" : "") + " from this claim — go to the first"}>
                {mine.length}&thinsp;×</button>
            : <span className="tcards none" title="no card came from this claim">—</span>}
          {node.anchor
            ? <button className="tanchor" onClick={() => onAnchor(node.anchor as string)} title="show me this in the source">{node.anchor}</button>
            : null}
        </div>
      </div>
      {isOpen && qs.length
        ? <ul className="tqs">{qs.map((q, i) => <li key={i}>{q}</li>)}</ul>
        : null}
      {isOpen && kids.length
        ? <ul className="tkids">{kids.map((k) => <TreeNodeRow key={k.id} node={k} cardsByNode={cardsByNode}
            onAnchor={onAnchor} onCards={onCards} open={open} onToggle={onToggle} />)}</ul>
        : null}
    </li>
  );
}

export interface TreeState {
  data?: (TreeResponse & { tree: (TreeResponse["tree"] & { glossary?: GlossaryEntry[] }) | null }) | TreeStatusOnly | null;
  missing?: boolean;
}
interface TreeStatusOnly { status: string; error?: string; tree?: undefined; cards?: undefined; question?: undefined }
interface GlossaryEntry { term: string; kernel: string; anchor?: string }

interface TreeViewProps<C extends TreeCard> {
  state: TreeState | null | undefined;
  src: { id?: unknown; filename?: string } | null | undefined;
  cards: C[] | null | undefined;
  onAnchor: (anchor: string) => void;
  onCards: (card: C) => void;
  onDistil?: (() => void) | null;
  onClose: () => void;
}

export function TreeView<C extends TreeCard>({ state, src, cards, onAnchor, onCards, onDistil, onClose }: TreeViewProps<C>) {
  const t = state && state.data;
  const nodes = (t && t.tree && t.tree.nodes) || [];
  const { root: synth, pillars } = liftSynthesis(nodes);
  const [open, setOpen] = useState<Open>({});
  const [gloss, setGloss] = useState(false);
  const srcId = src && src.id;
  useEffect(() => { setOpen({}); setGloss(false); }, [srcId]);
  const toggle = (id: string) => setOpen((m) => ({ ...m, [id]: !m[id] }));
  const allIds = (ns: TreeNode[], acc: string[] = []): string[] => { for (const n of ns) { acc.push(n.id); allIds(n.children || [], acc); } return acc; };
  const anyOpen = Object.values(open).some(Boolean);
  const openAll = () => setOpen(anyOpen ? {} : Object.fromEntries(allIds(nodes).map((id) => [id, true])));
  const cardsByNode = new Map<unknown, C[]>();
  for (const c of cards || []) {
    if (!c.node) continue;
    if (!cardsByNode.has(c.node)) cardsByNode.set(c.node, []);
    (cardsByNode.get(c.node) as C[]).push(c);
  }
  const count = (ns: TreeNode[]): number => ns.reduce((a, n) => a + 1 + count(n.children || []), 0);
  const asked = (ns: TreeNode[]): number => ns.reduce((a, n) => a + (n.questions || []).length + asked(n.children || []), 0);
  const status = t ? t.status : state && state.missing ? "none" : "loading";
  const glossary = (t && t.tree && t.tree.glossary) || [];

  return (
    <div className="page-col treeview">
      <div className="thead">
        <span className="tsrc">{src ? src.filename : "source"}</span>
        {status === "ready"
          ? <span>{count(nodes)} claims · {asked(nodes)} questions · {t?.cards} cards</span>
          : <span className="tstate">{status === "loading" ? "reading…" : status}</span>}
        <span className="tgrow" />
        {status === "ready" && nodes.length
          ? <button className="tclose" onClick={openAll}>{anyOpen ? "collapse all" : "expand all"}</button>
          : null}
        <button className="tclose" onClick={onClose} title="back to the source (t)">t · source</button>
      </div>

      {status === "ready" && t?.question ? <p className="tq">{t.question}</p> : null}

      {status === "ready" && glossary.length
        ? <div className="tgloss">
            <div className="tglosshead" onClick={() => setGloss((g) => !g)}>
              <span className={"ttw" + (gloss ? "" : " leaf")}>{gloss ? "▾" : "▸"}</span>
              {glossary.length} terms · the vocabulary the deck teaches first
            </div>
            {gloss
              ? <ul className="tglossl">{glossary.map((g, i) =>
                  <li key={i}>
                    <span className="tterm">{g.term}</span>
                    <span className="tkernel">{g.kernel}</span>
                    {g.anchor ? <button className="tanchor" onClick={() => onAnchor(g.anchor as string)} title="show me this in the source">{g.anchor}</button> : null}
                  </li>)}</ul>
              : null}
          </div>
        : null}

      {status === "ready" && synth
        ? <div className="tsynth">
            <div className="tsynth-l">the whole</div>
            <ul className="ttree"><TreeNodeRow node={{ ...synth, children: [] }} cardsByNode={cardsByNode}
              onAnchor={onAnchor} onCards={onCards} open={open} onToggle={toggle} /></ul>
          </div>
        : null}
      {status === "ready"
        ? <ul className="ttree">{pillars.map((n) => <TreeNodeRow key={n.id} node={n} cardsByNode={cardsByNode}
            onAnchor={onAnchor} onCards={onCards} open={open} onToggle={toggle} />)}</ul>
        : null}

      {status === "running" || status === "carding" || status === "pending"
        ? <p className="tnote"><span className="kg-pulse">◆</span>{" "}
            {status === "carding" ? "the tree is built — writing the deck now." : "reading the source and laying out its claims."}{" "}
            This takes a minute or two; it keeps going if you leave.</p>
        : null}

      {status === "error"
        ? <p className="tnote err">That didn’t work: {t?.error || "unknown error"}
            {onDistil ? <> — <button className="tlink" onClick={onDistil}>try again</button></> : null}</p>
        : null}

      {status === "none"
        ? <p className="tnote">No tree for this source yet. Sources distil themselves when they arrive, so this
            one predates that{onDistil ? <> — <button className="tlink" onClick={onDistil}>build it now</button></> : null}.</p>
        : null}
    </div>
  );
}
