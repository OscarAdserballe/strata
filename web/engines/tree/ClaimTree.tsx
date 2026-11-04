import { useState } from "react";
import type { SessionMet } from "../../../shared/types/index.ts";
import { MathText } from "../prose/math.tsx";
import { tex } from "../prose/text.ts";
import { liftSynthesis } from "./tree.ts";
import { PHONE } from "../../platform/device.js";

export function Line({ text, max = PHONE ? 84 : 132 }: { text: unknown; max?: number }) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return <MathText text={tex(s.length > max ? `${s.slice(0, max - 1)}…` : s)} />;
}

export function Met({ m }: { m: SessionMet }) {
  return (
    <div className={"smcard" + (m.missed ? " miss" : "")}>
      <span className="smv">{m.missed ? "✗" : "✓"}</span>
      <span className="smq"><Line text={m.front} /></span>
      {m.missed && m.got ? <span className="smthen">then got it</span> : null}
    </div>
  );
}

export interface FlatClaim {
  id: string;
  label: string;
  depth: number;
  kind?: string | null;
  met?: SessionMet[];
}
export type Nested<C extends FlatClaim> = C & { met: SessionMet[]; children: Nested<C>[] };

// The list is in tree order, so a claim's parent is the last shallower one before it.
export function nest<C extends FlatClaim>(claims: readonly C[] | null | undefined): Nested<C>[] {
  const roots: Nested<C>[] = [];
  const stack: Nested<C>[] = [];
  for (const c of claims || []) {
    const node: Nested<C> = { ...c, met: c.met || [], children: [] };
    while (stack.length && stack[stack.length - 1].depth >= c.depth) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node); else roots.push(node);
    stack.push(node);
  }
  return roots;
}

type ClaimNode = Nested<FlatClaim>;
type Lit = (c: ClaimNode) => boolean;
type Here = string | null | undefined;

const litFor = (claims: readonly FlatClaim[], here: Here, dim: boolean): Lit => {
  // Dim only when the contrast is meaningful; in the review the whole tree is context.
  const anyMet = claims.some((c) => c.met && c.met.length);
  if (!dim || (!here && !anyMet)) return () => true;
  const lit: Lit = (c) => c.met.length > 0 || c.id === here || c.children.some(lit);
  return lit;
};

function touchedBranches(roots: ClaimNode[], here: Here): Set<string> {
  const open = new Set<string>();
  const visit = (c: ClaimNode): boolean => {
    let touched = c.id === here || c.met.length > 0;
    for (const child of c.children) touched = visit(child) || touched;
    if (touched && c.children.length) open.add(c.id);
    return touched;
  };
  for (const root of roots) visit(root);
  return open;
}

interface ClaimProps {
  c: ClaimNode;
  here: Here;
  lit: Lit;
  open: Set<string>;
  toggle: (id: string) => void;
}

function Claim({ c, here, lit, open, toggle }: ClaimProps) {
  const on = lit(c);
  const isHere = c.id === here;
  const hasKids = c.children.length > 0;
  const label = <>
    {hasKids ? <span className={"smfold" + (open.has(c.id) ? " open" : "")}>›</span> : <span className="smfold blank" />}
    <span className="smcid">{String(c.id).replace(/^n/, "")}</span>
    <span className="smctext"><Line text={c.label} max={PHONE ? 90 : 150} /></span>
    {isHere ? <span className="smhere">this card</span> : null}
  </>;
  return (
    <li className={"smnode" + (on ? "" : " off") + (isHere ? " here" : "")}>
      {hasKids
        ? <button type="button" className="smclabel" aria-expanded={open.has(c.id)} onClick={() => toggle(c.id)}>{label}</button>
        : <div className="smclabel">{label}</div>}
      {c.met.map((m) => <Met key={m.card} m={m} />)}
      {hasKids && open.has(c.id)
        ? <ul className="smtree sub">{c.children.map((k) => <Claim key={k.id} c={k} here={here} lit={lit} open={open} toggle={toggle} />)}</ul>
        : null}
    </li>
  );
}

// A generated tree has a single synthesis root; drawn as a node, it would fold every pillar under it.
function Synthesis({ c, here, lit }: Pick<ClaimProps, "c" | "here" | "lit">) {
  const on = lit(c);
  const isHere = c.id === here;
  return (
    <div className={"smsynth" + (on ? "" : " off") + (isHere ? " here" : "")}>
      <div className="smsynth-l">the whole</div>
      <div className="smclabel">
        <span className="smcid">{String(c.id).replace(/^n/, "")}</span>
        <span className="smctext"><Line text={c.label} max={PHONE ? 110 : 180} /></span>
        {isHere ? <span className="smhere">this card</span> : null}
      </div>
      {c.met.map((m) => <Met key={m.card} m={m} />)}
    </div>
  );
}

export interface ClaimTreeProps {
  claims: readonly FlatClaim[];
  here?: string | null;
  dim?: boolean;
}

function ClaimTree({ claims, here, dim = true }: ClaimTreeProps) {
  const { root, pillars: roots } = liftSynthesis(nest(claims));
  const lit = litFor(claims, here, dim);
  const [open, setOpen] = useState(() => touchedBranches(roots, here));
  const toggle = (id: string) => setOpen((before) => {
    const after = new Set(before);
    if (after.has(id)) after.delete(id); else after.add(id);
    return after;
  });
  if (!claims || !claims.length) return null;
  return (
    <>
      {root ? <Synthesis c={root} here={here} lit={lit} /> : null}
      <ul className="smtree">
        {roots.map((c) => <Claim key={c.id} c={c} here={here} lit={lit} open={open} toggle={toggle} />)}
      </ul>
    </>
  );
}

export default ClaimTree;
