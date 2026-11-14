import { useEffect, useRef, useState, type DragEvent } from "react";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { boards } from "../../data/entities/sources.ts";
import { plan, planGestures, type PlanAnswer } from "../../data/entities/plan.ts";
import { refreshRegister } from "../../data/entities/register.ts";
import { addSource } from "../../capabilities/sources/AddSource.tsx";
import { dayKey } from "../../capabilities/today/days.ts";
import { shortDay } from "../../capabilities/today/projects.ts";
import "./new-project.css";

interface Unit { key: string; name: string; byDate: string; items: string[] }
interface Draft { units: Unit[]; loose: string[] }

export interface NewProjectProps {
  onCancel(): void;
  onCreated(board: string): void;
}

/** A unit's date, spread evenly from today to the project's end. */
export function spreadDates(n: number, endsAt: string, today = new Date()): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endsAt);
  if (!m || !n) return Array(n).fill("");
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const span = Math.max(n, Math.round((end.getTime() - start.getTime()) / 864e5));
  return Array.from({ length: n }, (_, i) => dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + Math.round(((i + 1) * span) / n))));
}

const ARRIVE_MS = 120_000;

export default function NewProject({ onCancel, onCreated }: NewProjectProps) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [ends, setEnds] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [link, setLink] = useState("");
  const [links, setLinks] = useState<string[]>([]);
  const [board, setBoard] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [step, setStep] = useState<"form" | "arriving" | "draft">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hover, setHover] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const wanted = files.length + links.length;

  const write = (id: string, w: Parameters<typeof plan.write>[1]) => plan.write(id, w) as Promise<PlanAnswer>;

  async function start() {
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const made = await boards.create({ title: name.trim() });
      const id = made.board.id;
      setBoard(id);
      if (goal.trim()) await write(id, planGestures.purpose(goal.trim()));
      if (ends) await write(id, planGestures.project({ endsAt: ends }));
      if (files.length) await addSource.files(files, id);
      for (const url of links) await addSource.saveLink(id, url).catch(() => "added");
      if (!wanted) { refreshRegister(); onCreated(id); return; }
      setStep("arriving");
      await arrive(id);
    } catch (e) { if (live.current) setError(StrataWhy(e, "couldn't start the project")); }
    finally { if (live.current) setBusy(false); }
  }

  // Imports land in the background: wait for the sources, backing off, then ask for the draft.
  async function arrive(id: string) {
    const until = Date.now() + ARRIVE_MS;
    let wait = 1000, got: Record<string, string> = {};
    for (;;) {
      const st = await StrataAPI.getBoard(id);
      got = Object.fromEntries((st.resources || []).map((r: { id: string; filename: string }) => [r.id, r.filename]));
      if (!live.current) return;
      if (Object.keys(got).length >= wanted || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 8000);
    }
    setNames(got);
    if (!Object.keys(got).length) { setDraft({ units: [], loose: [] }); setStep("draft"); return; }
    const d = await StrataAPI.planDraft(id);
    if (!live.current) return;
    const dates = spreadDates(d.units.length, ends);
    setDraft({ units: d.units.map((u, i) => ({ key: `u${i}`, name: u.name, byDate: dates[i], items: u.items })), loose: d.loose });
    setStep("draft");
  }

  async function create(empty: boolean) {
    if (!board || busy) return;
    setBusy(true); setError("");
    try {
      if (!empty && draft) for (const u of draft.units) {
        const r = await write(board, planGestures.addGroup(u.name.trim() || "Unit", u.byDate));
        if (r?.id && u.items.length) await write(board, planGestures.order(r.id, u.items));
      }
      refreshRegister();
      onCreated(board);
    } catch (e) { if (live.current) setError(StrataWhy(e, "couldn't save the units")); }
    finally { if (live.current) setBusy(false); }
  }

  const edit = (key: string, patch: Partial<Unit>) => setDraft((d) => d && { ...d, units: d.units.map((u) => (u.key === key ? { ...u, ...patch } : u)) });
  const move = (i: number, by: number) => setDraft((d) => {
    if (!d) return d;
    const us = d.units.slice(), j = i + by;
    if (j < 0 || j >= us.length) return d;
    [us[i], us[j]] = [us[j], us[i]];
    return { ...d, units: us };
  });
  const remove = (key: string) => setDraft((d) => d && { units: d.units.filter((u) => u.key !== key), loose: d.loose.concat(d.units.find((u) => u.key === key)?.items ?? []) });
  const moveItem = (item: string, to: string) => setDraft((d) => {
    if (!d) return d;
    const units = d.units.map((u) => ({ ...u, items: u.items.filter((x) => x !== item).concat(u.key === to ? [item] : []) }));
    return { units, loose: d.loose.filter((x) => x !== item).concat(to === "" ? [item] : []) };
  });
  const drop = {
    onDragOver(e: DragEvent) { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setHover(true); } },
    onDragLeave() { setHover(false); },
    onDrop(e: DragEvent) { e.preventDefault(); setHover(false); setFiles((f) => f.concat(Array.from(e.dataTransfer.files))); },
  };

  if (step === "form" || step === "arriving") return (
    <div className="newproj">
      <h1>New project</h1>
      <form onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <label className="np-label" htmlFor="np-name">Name</label>
        <input id="np-name" className="np-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Applied Urban Economics" autoFocus />
        <label className="np-label" htmlFor="np-goal">What is it for?</label>
        <input id="np-goal" className="np-input goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Pass the exam in January, and understand why…" />
        <label className="np-label" htmlFor="np-ends">Ends <span>optional</span></label>
        <input id="np-ends" className="np-input date" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
        <div className="np-label">Material</div>
        <div className={"np-drop" + (hover ? " on" : "")} {...drop}>
          <span>Drop files, or <button type="button" className="td-link" onClick={() => document.getElementById("np-files")?.click()}>choose them</button>, or paste a link</span>
          <input id="np-files" type="file" multiple accept=".pdf,.md,.txt,.html,.htm" hidden onChange={(e) => { setFiles((f) => f.concat(Array.from(e.target.files || []))); e.target.value = ""; }} />
          <span className="np-link"><input aria-label="A link" value={link} placeholder="https://…" onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && /^https?:\/\//.test(link.trim())) { e.preventDefault(); setLinks((l) => l.concat(link.trim())); setLink(""); } }} /></span>
          {wanted ? <span className="np-count">{wanted} added</span> : null}
        </div>
        {error ? <div className="rg-err" role="alert">{error}</div> : null}
        <div className="np-go">
          <button type="button" className="td-link" onClick={onCancel}>Cancel</button>
          <button className="td-primary" disabled={!name.trim() || busy}>
            {step === "arriving" ? `Drafting from ${wanted} source${wanted === 1 ? "" : "s"}…` : wanted ? "Draft the units" : "Create project"}</button>
        </div>
      </form>
    </div>
  );

  const units = draft?.units ?? [];
  const loose = draft?.loose ?? [];
  const n = Object.keys(names).length;
  return (
    <div className="newproj wide">
      <div className="np-crumb">Projects / New</div>
      <h1>{name}</h1>
      {goal ? <p className="np-goal">{goal}</p> : null}
      <p className="np-lead">{units.length ? <>Claude’s draft, from your {n} file{n === 1 ? "" : "s"}. Rename, reorder, move sources between units, or delete a unit.</>
        : n ? "No units drafted. Start empty and add units on the project page." : "No sources yet. Start empty and add them on the project page."}</p>
      {units.map((u, i) => <div key={u.key} className={"np-unit" + (open === u.key ? " open" : "")}>
        <div className="np-urow">
          <span className="np-n">{i + 1}</span>
          <input className="np-uname" aria-label={`Unit ${i + 1} name`} value={u.name} onChange={(e) => edit(u.key, { name: e.target.value })} />
          <span className="np-umeta">{u.byDate ? `by ${shortDay(u.byDate, true)} · ` : ""}{u.items.length} source{u.items.length === 1 ? "" : "s"}</span>
          <button className="np-x" aria-label="Show sources" aria-expanded={open === u.key} onClick={() => setOpen(open === u.key ? null : u.key)}>{open === u.key ? "▾" : "▸"}</button>
          <button className="np-x" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}>↑</button>
          <button className="np-x" aria-label="Move down" disabled={i === units.length - 1} onClick={() => move(i, 1)}>↓</button>
          <button className="np-x" aria-label={`Delete unit ${i + 1}`} onClick={() => remove(u.key)}>×</button>
        </div>
        {open === u.key ? <ul className="np-items">{u.items.map((it) => <li key={it}>
          <i className="pp-dot" /><span>{names[it] || it}</span>
          <select aria-label="Move to" value={u.key} onChange={(e) => moveItem(it, e.target.value)}>
            {units.map((x, k) => <option key={x.key} value={x.key}>Unit {k + 1}</option>)}<option value="">Loose ends</option>
          </select>
        </li>)}</ul> : null}
      </div>)}
      {loose.length ? <div className="np-unit loose">
        <div className="np-urow"><span className="np-uname static">Loose ends · {loose.length}</span></div>
        <ul className="np-items">{loose.map((it) => <li key={it}><i className="pp-dot" /><span>{names[it] || it}</span>
          {units.length ? <select aria-label="Move to" value="" onChange={(e) => moveItem(it, e.target.value)}>
            <option value="">Loose ends</option>{units.map((x, k) => <option key={x.key} value={x.key}>Unit {k + 1}</option>)}
          </select> : null}</li>)}</ul>
      </div> : null}
      {error ? <div className="rg-err" role="alert">{error}</div> : null}
      <div className="np-go">
        <button className="td-link" disabled={busy} onClick={() => void create(true)}>Start empty</button>
        <button className="td-primary" disabled={busy} onClick={() => void create(false)}>Create project</button>
      </div>
    </div>
  );
}
