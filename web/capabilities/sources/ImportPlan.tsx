/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type ReactNS from "react";
import type { CSSProperties, InputHTMLAttributes } from "react";
import type { createPortal as Portal } from "react-dom";
import { pageGroups, studyTokens } from "../../../shared/imports/budget.ts";
import { compileImportPlan, subtree, units, type Heading } from "../../../shared/imports/import-plan.ts";

// imports nothing the main bundle imports, or esbuild would hoist it into a chunk every boot loads
let React = null as unknown as typeof ReactNS, createPortal = null as unknown as typeof Portal;
export function bind(host: { React: typeof ReactNS; createPortal: typeof Portal }) { React = host.React; createPortal = host.createPortal; }
const useEffect: typeof ReactNS.useEffect = (...a) => React.useEffect(...a), useLayoutEffect: typeof ReactNS.useLayoutEffect = (...a) => React.useLayoutEffect(...a);
const useRef: typeof ReactNS.useRef = (v?: any) => React.useRef(v), useState: typeof ReactNS.useState = (v?: any) => React.useState(v);

export interface PlanSource {
  title: string;
  outline: Heading[];
  defaultStarts: number[];
  pageText?: string[];
  budgetTokens?: number;
  hasBookmarks?: boolean;
  startByPages?: boolean;
}
export interface PlanChoice { outline: Heading[]; starts: number[]; excluded: number[] }

export interface ImportPlanProps {
  source: PlanSource;
  plan?: PlanChoice | null;
  onClose: () => void;
  onConfirm: (plan: PlanChoice) => void;
  draftKey?: string | null;
  saving?: boolean;
  hint?: string;
  confirmLabel?: string;
}

function Check({ mixed, ...props }: { mixed: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" ref={el => { if (el) el.indeterminate = mixed; }} {...props} />;
}

export default function ImportPlan({ source, plan, onClose, onConfirm, draftKey, saving = false, hint, confirmLabel }: ImportPlanProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft] = useState<{ pageMode?: boolean; plan?: PlanChoice } | null>(() => {
    try { return draftKey ? JSON.parse(localStorage.getItem(draftKey) || 'null') : null; } catch { return null; }
  });
  const editing = !!plan;
  plan = plan ?? draft?.plan;
  const [pageMode, setPageMode] = useState(draft?.pageMode ?? !!source.startByPages);
  const original = source;
  if (pageMode) source = {...source,...pageGroups(source.pageText!,source.budgetTokens!)};
  const [starts, setStarts] = useState<number[]>(plan?.starts ?? source.defaultStarts);
  const [excluded, setExcluded] = useState(new Set<number>(plan?.excluded));
  const [collapsed, setCollapsed] = useState(new Set<number>(source.outline.map(r => r.id)));
  useEffect(() => {
    if (draftKey) try { localStorage.setItem(draftKey,JSON.stringify({pageMode,plan:{outline:source.outline,starts,excluded:[...excluded]}})); } catch { /* server keeps the saved file and pending choice */ }
  }, [draftKey,pageMode,starts,excluded]);
  const groups = units(source.outline, starts, excluded);
  let problem = "";
  if (source.pageText) {
    try {
      const selected = compileImportPlan({outline:source.outline,starts,excluded:[...excluded]},source.pageText);
      if (selected.some(unit => studyTokens(unit,source.pageText!) > source.budgetTokens!)) problem = "A group exceeds the token budget. Split it, exclude material, or group by pages.";
    } catch (error) { problem = (error as Error).message; }
  }
  const changed = excluded.size > 0 || JSON.stringify([...starts].sort((a,b) => a-b)) !== JSON.stringify(source.defaultStarts);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement;
    element.showModal();
    return () => { element.close(); (opener as HTMLElement | null)?.focus(); };
  }, []);
  const toggle = (row: Heading) => {
    const family = subtree(source.outline, row.id);
    const remove = family.some(r => !excluded.has(r.id));
    setExcluded(prev => { const next = new Set(prev); family.forEach(r => remove ? next.add(r.id) : next.delete(r.id)); return next; });
  };
  const toggleBreak = (index: number) => setStarts(prev => prev.includes(index) ? prev.filter(n => n !== index) : [...prev, index]);
  const isVisible = (row: Heading) => {
    let parent = row.parent;
    while (parent !== null) { if (collapsed.has(parent)) return false; parent = source.outline[parent].parent; }
    return true;
  };
  return createPortal(<dialog className="import-modal" ref={dialog} onKeyDown={event => event.stopPropagation()} aria-labelledby="import-title" aria-describedby="import-hint" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="modal-header"><div><h2 id="import-title">{source.title}</h2><p id="import-hint">{hint ?? "Suggested groups. Untick anything you don’t want to study."}</p></div><button className="close" aria-label="Close" onClick={onClose}>×</button></header>
    {problem && <p role="alert" className="import-budget-error">{problem}</p>}
    {source.pageText && <div className="outline-toolbar"><span>Up to {source.budgetTokens!.toLocaleString()} tokens per group</span>{source.hasBookmarks !== false && <button className="text-button" onClick={() => {
      const next = pageMode ? original : pageGroups(source.pageText!,source.budgetTokens!);
      setPageMode(!pageMode); setStarts(next.defaultStarts); setExcluded(new Set()); setCollapsed(new Set());
    }}>{pageMode ? "Use outline" : "Group by pages"}</button>}</div>}
    <div className="outline-toolbar"><span>Contents</span><button className="text-button" onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(source.outline.map(r => r.id)))}>{collapsed.size ? 'Expand all' : 'Collapse all'}</button></div>
    <div className="outline" aria-label="Source contents">
      {source.outline.map((row,index) => {
        if (!isVisible(row)) return null;
        const family = subtree(source.outline,index);
        const selected = family.filter(r => !excluded.has(r.id)).length;
        const children = family.length > 1;
        const start = groups.findIndex(g => g.start === index);
        return <React.Fragment key={row.id}>
          {start >= 0 && <div className="unit-divider"><span>Unit {start+1}</span>{start > 0 && <button onClick={() => {
            const prior = groups[start-1].start;
            setStarts(prev => prev.filter(n => n <= prior || n > index));
          }} aria-label={`Join unit ${start+1} with previous`}>Join with previous</button>}</div>}
          <div className={'outline-row ' + (excluded.has(row.id) ? 'excluded' : '')} style={{'--depth':row.depth} as CSSProperties}>
            <span className="row-indent"/>
            {children ? <button className="disclosure" aria-label={`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${row.label}`} aria-expanded={!collapsed.has(row.id)} onClick={() => setCollapsed(prev => { const next = new Set(prev); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next; })}>{collapsed.has(row.id) ? '›' : '⌄'}</button> : <span className="disclosure"/>}
            <Check aria-label={`Include ${row.label}`} checked={selected > 0} mixed={selected > 0 && selected < family.length} onChange={() => toggle(row)}/>
            <span className="row-label">{row.label}</span><span className="page">{row.page ?? '—'}</span>
            {index > 0 && !excluded.has(row.id) ? <button className="split" onClick={() => toggleBreak(index)} aria-label={`${starts.includes(index) ? 'Join before' : 'Split before'} ${row.label}`}>{starts.includes(index) ? 'Join' : 'Split'}</button> : <span className="split-space"/>}
          </div>
        </React.Fragment>;
      })}
    </div>
    <footer className="modal-footer"><div><span role="status">{groups.length} study {groups.length === 1 ? 'unit' : 'units'}</span>{changed && <button className="text-button reset" onClick={() => { setStarts(source.defaultStarts); setExcluded(new Set()); }}>Reset</button>}</div><div className="actions"><button className="cancel" onClick={onClose}>{draftKey ? "Decide later" : "Cancel"}</button><button className="primary" disabled={!groups.length || !!problem || saving} onClick={() => onConfirm({outline:source.outline,starts,excluded:[...excluded]})}>{confirmLabel ?? (editing ? 'Save' : 'Add source')}</button></div></footer>
  </dialog>, document.body);
}
