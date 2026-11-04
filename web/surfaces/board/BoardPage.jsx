import React from "react";
import Verbs from "../../capabilities/sources/SourceVerbs.tsx";
import { loadCapture } from "../../capabilities/sources/AddSource.tsx";
import "./board-page.css";

const { useState, useEffect, useMemo, useRef } = React;

const allSeen = (t) => (t.cards || 0) > 0 && (t.seen || 0) >= t.cards;
const isDone = (t) => !!t.doneAt || (allSeen(t) && !!(t.kp && t.kp.benched));
const stateOf = (t) => (isDone(t) ? "done" : t.read === "opened" || t.read === "read" || (t.seen || 0) > 0 ? "reading" : "new");
const stateWord = (t) => (isDone(t) ? "Finished" : t.read === "read" ? "Read through" : stateOf(t) === "reading" ? "Reading" : "Not started");
const dayOf = (ts) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const EMPTY_PLAN = { purpose: "", groups: [], milestones: [], places: {} };

function Ghost({ value, onCommit, cls, placeholder, label, area }) {
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  const done = () => { if ((v || "") !== (value || "")) onCommit(v); };
  const El = area ? "textarea" : "input";
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (area && el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } }, [v, area]);
  return <El ref={ref} rows={area ? 1 : undefined} className={"bp-ghost " + (cls || "")} value={v} placeholder={placeholder} aria-label={label}
    onChange={(e) => setV(e.target.value)} onBlur={done}
    onKeyDown={(e) => {
      if (e.key === "Enter" && !area) { e.preventDefault(); e.currentTarget.blur(); }
      if (e.key === "Escape") { e.preventDefault(); setV(value || ""); e.currentTarget.blur(); }
    }} />;
}

const Dot = ({ t }) => <i className={"bp-dot " + stateOf(t)} />;

export default function BoardPage({
  boardId, tiles, plan: planIn, planApi, head, over, onBack, onBoards,
  onOpen, onWarm, onDel, onAside, onDistil, onDistilWarm, onKeep, onKeepWarm, onRenamed, onDone, onAdd, onCram, onCramWarm, log, work, issues, tools, leftRef,
  boardVerbs,
}) {
  const plan = planIn || EMPTY_PLAN;
  const verbs = { onDel, onAside, onDistil, onDistilWarm, onKeep, onKeepWarm, onDone };
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [opened, setOpened] = useState({});
  const [openMs, setOpenMs] = useState({});
  const [renaming, setRenaming] = useState(null);
  const [arm, setArm] = useState(null);
  const [stamped, setStamped] = useState(null);
  const [over2, setOver2] = useState(null);
  const [picked, setPicked] = useState([]);
  const [picking, setPicking] = useState(false);
  const drag = useRef(null);
  const anchor = useRef(null);
  useEffect(() => { setSel(null); setQ(""); setRenaming(null); setArm(null); setPicked([]); setPicking(false); }, [boardId]);

  const { srcs, yours, byKey } = useMemo(() => {
    const used = new Set(), byKey = new Map(), srcs = [];
    for (const t of tiles) {
      if (t.add || t.gap || t.kind === "log" || t.qgroup || t.ignoredPile) continue;
      const item = t.rid && !used.has(t.rid) ? t.rid : t.key;
      used.add(item);
      const it = { ...t, item };
      srcs.push(it); byKey.set(item, it);
    }
    return { srcs, byKey, yours: tiles.filter((t) => (t.qgroup || t.ignoredPile) && (t.cards || 0) > 0) };
  }, [tiles]);
  const place = (it) => plan.places[it.item] || { group: null, milestone: null, pinned: false, ord: null };
  const groupOf = (it) => { const g = place(it).group; return plan.groups.some((x) => x.id === g) ? g : null; };
  const inOrder = (list) => list.map((it, i) => [it, i]).sort((a, b) => {
    const oa = place(a[0]).ord, ob = place(b[0]).ord;
    return (oa == null ? 1e9 : oa) - (ob == null ? 1e9 : ob) || a[1] - b[1];
  }).map((x) => x[0]);
  const members = (gid) => inOrder(srcs.filter((it) => groupOf(it) === gid));
  const linked = (m) => srcs.filter((it) => place(it).milestone === m.id);
  const current = sel ? byKey.get(sel) : null;
  useEffect(() => { if (sel && !byKey.has(sel)) setSel(null); }, [sel, byKey]);
  const chosen = picked.filter((x) => byKey.has(x));
  const pickSet = new Set(chosen);
  const choosing = picking || chosen.length > 0;
  const stopChoosing = () => { setPicked([]); setPicking(false); setArm(null); };
  useEffect(() => {
    if (!choosing) return;
    const key = (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); setPicked([]); setPicking(false); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [choosing]);

  const needle = q.trim().toLowerCase();
  const hit = (it) => !needle || ((it.label || "") + " " + (it.file || "") + " " + (it.meta || "")).toLowerCase().includes(needle);
  const sections = plan.groups.map((g) => ({ key: g.id, name: g.name, group: g, items: members(g.id) }));
  const loose = members(null);
  if (loose.length || !plan.groups.length) sections.push({ key: "", name: plan.groups.length ? "Ungrouped" : "Sources", items: loose });
  const pinned = srcs.filter((it) => place(it).pinned && hit(it));
  const shut = (key) => !(opened[key] ?? key === "");
  const toggle = (key) => setOpened((x) => ({ ...x, [key]: shut(key) }));
  const orderInto = (gid, list) => { setOpened((x) => ({ ...x, [gid || ""]: true })); planApi.order(gid, list); };
  const shown = sections.flatMap((s) => (!needle && shut(s.key) ? [] : s.items.filter(hit)));
  const togglePick = (item) => { anchor.current = item; setPicked((list) => (list.includes(item) ? list.filter((x) => x !== item) : list.concat(item))); };
  const pickRun = (item) => {
    const order = shown.map((it) => it.item), a = order.indexOf(anchor.current), b = order.indexOf(item);
    if (a < 0 || b < 0) { togglePick(item); return; }
    const run = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    setPicked((list) => list.concat(run.filter((x) => !list.includes(x))));
  };

  const open = srcs.filter((t) => !isDone(t));
  const now = open.find((t) => t.cur) || open.find((t) => place(t).pinned)
    || open.slice().sort((a, b) => (b.last || 0) - (a.last || 0)).find((t) => t.last)
    || open.find((t) => stateOf(t) === "reading") || open[0] || srcs[0] || null;
  const offered = current || now;
  useEffect(() => { if (offered && onWarm && !offered.enter) onWarm(offered); }, [offered && offered.item]);
  const warmOn = (t) => (onWarm && !t.enter ? { onPointerEnter: () => onWarm(t), onPointerDown: () => onWarm(t) } : {});
  const reached = plan.milestones.filter((m) => m.doneAt).length;
  const nextMs = plan.milestones.find((m) => !m.doneAt) || null;

  const drop = (gid, beforeItem) => {
    const id = drag.current; drag.current = null; setOver2(null);
    if (!id || id === beforeItem) return;
    const list = members(gid).map((it) => it.item).filter((x) => x !== id);
    const at = beforeItem ? list.indexOf(beforeItem) : -1;
    if (at < 0) list.push(id); else list.splice(at, 0, id);
    orderInto(gid, list);
  };
  const dropProps = (key, gid, beforeItem) => ({
    onDragOver: (e) => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over2 !== key) setOver2(key); } },
    // let dropped files bubble up to the room's drop zone
    onDrop: (e) => { if (!drag.current) return; e.preventDefault(); e.stopPropagation(); drop(gid, beforeItem); },
  });

  const msDropProps = (m) => ({
    onDragOver: (e) => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = "link"; if (over2 !== "m:" + m.id) setOver2("m:" + m.id); } },
    onDrop: (e) => {
      if (!drag.current) return;
      e.preventDefault(); e.stopPropagation();
      const id = drag.current; drag.current = null; setOver2(null);
      planApi.place(id, { milestone: m.id }); setOpenMs((x) => ({ ...x, [m.id]: true }));
    },
  });

  const railItem = (it, droppable) => (
    <a href="#" key={it.item} draggable title={it.title || it.label}
      className={"bp-it" + (sel === it.item && !choosing ? " sel" : "") + (pickSet.has(it.item) ? " picked" : "") + (isDone(it) ? " done" : "") + (it.cur ? " cur" : "") + (over2 === "i:" + it.item ? " over" : "")}
      onClick={(e) => {
        e.preventDefault();
        if (e.shiftKey && anchor.current) pickRun(it.item);
        else if (e.metaKey || e.ctrlKey || choosing) togglePick(it.item);
        else { anchor.current = it.item; setSel(it.item); }
      }}
      onDragStart={(e) => { drag.current = it.item; e.dataTransfer.effectAllowed = "linkMove"; try { e.dataTransfer.setData("text/plain", it.item); } catch (_) { /* some engines refuse */ } }}
      onDragEnd={() => { drag.current = null; setOver2(null); }}
      {...(droppable ? dropProps("i:" + it.item, groupOf(it), it.item) : {})}>
      {choosing ? <span className="bp-box" aria-hidden="true">{pickSet.has(it.item) ? "✓" : ""}</span> : null}
      <Dot t={it} />
      <span className="bp-t">{it.label}</span>
      {it.busy ? <span className="dk-spin" title="the model is reading this in" /> : null}
      {place(it).pinned ? <span className="bp-pin" aria-label="pinned">★</span> : null}
    </a>
  );

  const rail = (
    <nav className="bp-rail" aria-label="Sources on this board">
      <div className="bp-rtop">
        <button className="bp-crumb" onClick={onBoards}>‹ All boards</button>
        {over ? <button className="bp-crumb" onClick={onBack} title="back to the card (esc)">the card ›</button> : null}
      </div>
      <button className={"bp-home" + (!sel ? " sel" : "")} onClick={() => setSel(null)} title="the board's front page">
        <span className="bp-hname">{head}</span>
        <span className="bp-hpurpose">{plan.purpose || "No purpose yet"}</span>
      </button>
      {boardVerbs ? <div className="bp-bverbs">{boardVerbs}</div> : null}
      {plan.milestones.length ? <>
        <div className="bp-bar" aria-hidden="true">{plan.milestones.map((m) => <b key={m.id} className={m.doneAt ? "on" : ""} />)}</div>
        <div className="bp-count">{reached} of {plan.milestones.length} milestones · {srcs.length} source{srcs.length === 1 ? "" : "s"}</div>
      </> : <div className="bp-count">{srcs.length} source{srcs.length === 1 ? "" : "s"}</div>}
      <label className="bp-search">
        <span aria-hidden="true">⌕</span>
        <input type="text" value={q} placeholder="Jump to…" aria-label="Filter sources" onChange={(e) => setQ(e.target.value)} />
      </label>

      {pinned.length ? <>
        <div className="bp-sec"><span className="bp-caret" /><span className="bp-sname">Pinned</span><span className="bp-cnt">{pinned.length}</span></div>
        {pinned.map((it) => railItem(it, false))}
      </> : null}

      {sections.map((s) => {
        const items = s.items.filter(hit);
        if (needle && !items.length) return null;
        const closed = !needle && shut(s.key);
        const fin = s.items.filter(isDone).length;
        return <React.Fragment key={s.key || "loose"}>
          <div className={"bp-sec" + (over2 === "s:" + s.key ? " over" : "")} {...dropProps("s:" + s.key, s.group ? s.group.id : null, null)}>
            <button className="bp-caret" aria-label={(closed ? "Expand " : "Collapse ") + s.name}
              onClick={() => toggle(s.key)}>{closed ? "▸" : "▾"}</button>
            {s.group && renaming === s.group.id
              ? <input className="bp-ren" autoFocus defaultValue={s.name} placeholder="Name — leave empty to delete"
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = s.name; e.currentTarget.blur(); } }}
                  onBlur={(e) => {
                    const v = e.target.value.trim(); setRenaming(null);
                    if (!v) planApi.delGroup(s.group.id); else if (v !== s.name) planApi.group(s.group.id, { name: v });
                  }} />
              : <button className="bp-sname" title={s.group ? "click to rename" : undefined}
                  onClick={() => (s.group ? setRenaming(s.group.id) : toggle(s.key))}>{s.name}</button>}
            <span className="bp-cnt">{fin}/{s.items.length}</span>
          </div>
          {closed ? null : items.length ? items.map((it) => railItem(it, true))
            : <div className={"bp-none" + (over2 === "n:" + s.key ? " over" : "")} {...dropProps("n:" + s.key, s.group ? s.group.id : null, null)}>
                {s.group ? "Empty — drag sources here." : "Nothing on this board yet."}</div>}
        </React.Fragment>;
      })}

      {yours.length ? <>
        <div className="bp-sec"><span className="bp-caret" /><span className="bp-sname">Yours</span></div>
        {yours.map((t) => (
          <a href="#" key={t.key} className={"bp-it" + (t.cur ? " cur" : "")} onClick={(e) => { e.preventDefault(); onOpen(t); }}>
            <i className="bp-dot mine" /><span className="bp-t">{t.label}</span><span className="bp-cnt">{t.meta}</span>
          </a>
        ))}
      </> : null}

      <div className="bp-rfoot">
        <button className="bp-link" onClick={() => planApi.addGroup().then((id) => { if (id) { setOpened((x) => ({ ...x, [id]: true })); setRenaming(id); } })}>+ New group</button>
        {srcs.length > 1 || choosing ? <button className="bp-link" onClick={() => (choosing ? stopChoosing() : setPicking(true))}>{choosing ? "Done selecting" : "Select several"}</button> : null}
        {onAdd ? <>
          <button className="bp-link" onClick={() => onAdd("file")}>+ Add a file</button>
          <button className="bp-link" onPointerDown={() => void loadCapture().catch(() => {})} onClick={() => onAdd("link")}>+ Add from a link</button>
        </> : null}
        {tools ? <div className="bp-tools-slot">{tools}</div> : null}
      </div>
    </nav>
  );

  const srcRow = (it, unlink) => (
    <div className="bp-srow" key={it.item}>
      <button className={"bp-src" + (isDone(it) ? " done" : "")} onClick={() => setSel(it.item)}>
        <Dot t={it} /><span className="bp-t">{it.label}</span>{it.pages ? <span className="bp-p">{it.pages} p</span> : null}
      </button>
      {unlink ? <button className="bp-x" aria-label={"Unlink " + it.label} onClick={() => planApi.place(it.item, { milestone: null })}>×</button> : null}
    </div>
  );

  const front = () => (
    <div className="bp-front">
      {work}
      <div className="bp-doors">
        <div>
          {now ? <>
            <div className="bp-eyebrow">{stateOf(now) === "reading" ? "Pick up where you left off" : isDone(now) ? "Everything here is finished" : "Next up"}</div>
            <h2 className="bp-big">{now.label}</h2>
            <p className="bp-sub">{now.meta}</p>
            <div className="bp-row">
              <button className="bp-btn primary" {...warmOn(now)} onClick={() => onOpen(now)}>{now.enter ? "Open the book" : stateOf(now) === "reading" ? "Resume" : "Open"} <span>→</span></button>
              <button className="bp-btn quiet" onClick={() => setSel(now.item)}>Details</button>
              {onCram ? <button className="bp-btn quiet" onPointerEnter={onCramWarm} onPointerDown={onCramWarm} onClick={onCram} title="drill the cards you choose, in rounds, off the review schedule (x)">Cram</button> : null}
            </div>
          </> : <>
            <div className="bp-eyebrow">Nothing here yet</div>
            <h2 className="bp-big">Add the first source</h2>
            <p className="bp-sub">Drop a file anywhere, or use the links at the bottom of the list.</p>
          </>}
        </div>
        <div>
          <div className="bp-eyebrow">{head} · the purpose</div>
          <Ghost cls="bp-purpose" area value={plan.purpose} placeholder="What is this board for?" label="Board purpose" onCommit={(v) => planApi.purpose(v)} />
          <p className="bp-sub">{plan.milestones.length
            ? <>{reached} of {plan.milestones.length} milestones reached{nextMs ? <> · next: <b>{nextMs.name}</b></> : " · all of them"}</>
            : "No milestones yet."}</p>
          {plan.milestones.length ? <div className="bp-bar wide" aria-hidden="true">{plan.milestones.map((m) => <b key={m.id} className={m.doneAt ? "on" : ""} />)}</div> : null}
        </div>
      </div>

      <div className="bp-h2row"><h2>Milestones</h2><span>yours to set and tick — nothing here is automatic</span></div>
      <ol className="bp-check">
        {plan.milestones.map((m, i) => {
          const l = linked(m), fin = l.filter(isDone).length, isOpen = !!openMs[m.id];
          return (
            <li key={m.id} className={(m.doneAt ? "done" : "") + (over2 === "m:" + m.id ? " over" : "")} {...msDropProps(m)}>
              <div className="bp-mhead">
                <button className={"bp-tick" + (m.doneAt ? " on" : "")} aria-pressed={!!m.doneAt} aria-label="Milestone reached"
                  onClick={() => { if (!m.doneAt) setStamped(m.id); planApi.milestone(m.id, { done: !m.doneAt }); }}>✓</button>
                <Ghost cls="bp-mname" value={m.name} label="Milestone name" onCommit={(v) => planApi.milestone(m.id, { name: v.trim() || "Untitled milestone" })} />
                {m.doneAt
                  ? <span className={"bp-stamp" + (stamped === m.id ? " pop" : "")}>Reached {dayOf(m.doneAt)}</span>
                  : nextMs && nextMs.id === m.id ? <span className="bp-now">now</span> : null}
                <button className="bp-chip" aria-expanded={isOpen} onClick={() => setOpenMs((x) => ({ ...x, [m.id]: !x[m.id] }))}>
                  {l.length ? fin + "/" + l.length + " sources" : "no sources"} {isOpen ? "▴" : "▾"}</button>
                <Ghost cls="bp-mdate" value={m.due} placeholder="no date" label="Date" onCommit={(v) => planApi.milestone(m.id, { due: v.trim() })} />
                <span className="bp-tools">
                  <button disabled={i === 0} aria-label="Move earlier" onClick={() => planApi.milestone(m.id, { move: -1 })}>↑</button>
                  <button disabled={i === plan.milestones.length - 1} aria-label="Move later" onClick={() => planApi.milestone(m.id, { move: 1 })}>↓</button>
                  <button className={arm === m.id ? "arm" : ""} aria-label="Delete milestone" onBlur={() => setArm(null)}
                    onClick={() => { if (arm === m.id) { setArm(null); planApi.delMilestone(m.id); } else setArm(m.id); }}>{arm === m.id ? "delete?" : "×"}</button>
                </span>
              </div>
              {!m.doneAt && l.length && fin === l.length ? <div className="bp-nudge">Everything that counts toward this is finished — tick it off?</div> : null}
              {isOpen ? <div className="bp-msrc">
                {l.length ? l.map((it) => srcRow(it, true)) : <div className="bp-faint">Nothing linked. Drag a source here, or open one and set “Counts toward”. A milestone doesn’t need any.</div>}
                <Ghost cls="bp-mnote" area value={m.note} placeholder="Note to self — what does “reached” mean here?" label="Milestone note" onCommit={(v) => planApi.milestone(m.id, { note: v })} />
              </div> : null}
            </li>
          );
        })}
      </ol>
      <div className="bp-row"><button className="bp-btn" onClick={() => planApi.addMilestone()}>+ Add milestone</button></div>

      {log ? <div className="bp-log">{log}</div> : null}
    </div>
  );

  const bulk = () => {
    const items = srcs.filter((it) => pickSet.has(it.item)), n = items.length;
    const ids = items.map((it) => it.item);
    const moveTo = async (v) => {
      const gid = v === "+" ? await planApi.addGroup() : v === "-" ? null : v;
      if (v === "+" && !gid) return;
      orderInto(gid, members(gid).map((x) => x.item).filter((x) => !pickSet.has(x)).concat(ids));
      stopChoosing();
      if (v === "+") setRenaming(gid);
    };
    const del = () => { stopChoosing(); for (const it of items) onDel(it); };
    return (
      <div className="bp-cover bp-bulk">
        <div className="bp-eyebrow">{head} · selection</div>
        <h1 className="bp-title">{n ? n + (n === 1 ? " source" : " sources") + " selected" : "Select sources"}</h1>
        {n ? <>
          <div className="bp-row bp-acts">
            <label className="bp-field bp-move"><span>Move to group</span>
              <select value="" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => void moveTo(e.target.value)}>
                <option value="" disabled>Choose a group…</option>
                {plan.groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                <option value="-">Ungrouped</option>
                <option value="+">New group…</option>
              </select></label>
            {onDel ? <button className={"bp-btn" + (arm === "bulk" ? " bp-danger" : "")} onBlur={() => setArm(null)}
              onClick={() => (arm === "bulk" ? del() : setArm("bulk"))}>
              {arm === "bulk" ? "Delete " + n + " and all their cards?" : "Delete " + n}</button> : null}
            <button className="bp-btn quiet" onClick={stopChoosing}>Clear</button>
          </div>
          <div className="bp-msrc bp-picks">
            {items.map((it) => (
              <div className="bp-srow" key={it.item}>
                <span className={"bp-src" + (isDone(it) ? " done" : "")}><Dot t={it} /><span className="bp-t">{it.label}</span></span>
                <button className="bp-x" aria-label={"Unselect " + it.label} onClick={() => togglePick(it.item)}>×</button>
              </div>
            ))}
          </div>
        </> : <p className="bp-sub">Click sources in the list to select them. Shift-click selects a run; ⌘ or Ctrl-click selects without this mode.</p>}
      </div>
    );
  };

  const cover = (t) => {
    const pl = place(t), g = plan.groups.find((x) => x.id === pl.group), m = plan.milestones.find((x) => x.id === pl.milestone);
    const mates = members(groupOf(t)).filter((x) => x.item !== t.item).slice(0, 7);
    const issue = t.rid && issues ? issues[t.rid] : null;
    const door = t.enter ? "Open the book" : stateOf(t) === "reading" ? "Resume" : "Read";
    return (
      <div className="bp-cover">
        <button className="bp-crumb bp-narrow" onClick={() => setSel(null)}>‹ {head}</button>
        <div className="bp-eyebrow">{[t.kind === "pdf" ? (t.enter ? "Book" : "PDF") : t.kind === "deck" ? "Cards only" : t.kind, g && g.name, m && m.name].filter(Boolean).join(" · ")}</div>
        {renaming === "title" && onRenamed && t.rid
          ? <input className="bp-title bp-titleedit" autoFocus defaultValue={t.label} onFocus={(e) => e.target.select()}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = t.label; e.currentTarget.blur(); } }}
              onBlur={(e) => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== t.label) onRenamed(t, v); }} />
          : <h1 className="bp-title" onDoubleClick={() => (onRenamed && t.rid ? setRenaming("title") : null)} title={t.rid ? "double-click to rename" : undefined}>{t.label}</h1>}
        {t.meta ? <div className="bp-by">{t.meta}</div> : null}
        {issue ? <div className="bh-distil err bp-issue"><span className="bh-dwhat">{issue.error}</span>{issue.verb}</div> : null}
        <div className="bp-row bp-acts">
          <button className="bp-btn primary" {...warmOn(t)} onClick={() => onOpen(t)}>{door} <span>→</span></button>
          {t.rid && onDone ? <button className="bp-btn" onClick={() => onDone(t, !t.doneAt)}>{t.doneAt ? "Not finished after all" : "Mark finished"}</button> : null}
          {(t.keep || t.keepBoard) && onKeep ? <button className="bp-btn quiet" onPointerEnter={onKeepWarm} onPointerDown={onKeepWarm} onClick={() => onKeep(t)}>Choose what to keep</button> : null}
          <button className="bp-btn quiet" aria-pressed={!!pl.pinned} onClick={() => planApi.place(t.item, { pinned: !pl.pinned })}>{pl.pinned ? "★ Pinned" : "☆ Pin"}</button>
          <Verbs t={t} {...verbs} onRename={onRenamed && t.rid ? () => setRenaming("title") : undefined} />
        </div>
        <dl className="bp-facts">
          <div><dt>Length</dt><dd>{t.enter ? (t.sections || 0) + " sections" : t.pages ? t.pages + " pages" : "—"}</dd></div>
          <div><dt>Reading</dt><dd>{stateWord(t)}</dd></div>
          <div><dt>Highlights</dt><dd>{t.marksN || "—"}</dd></div>
          <div><dt>Cards kept</dt><dd>{t.kp ? (t.kp.benched ? "★ " + t.kp.kept + " of " + t.kp.total : "not chosen yet") : "—"}</dd></div>
        </dl>
        <div className="bp-two">
          <div>
            <label className="bp-field"><span>Group</span>
              <select value={groupOf(t) || ""} onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => { const gid = e.target.value || null; orderInto(gid, members(gid).map((x) => x.item).filter((x) => x !== t.item).concat(t.item)); }}>
                <option value="">{plan.groups.length ? "Ungrouped" : "No groups yet"}</option>
                {plan.groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select></label>
            <label className="bp-field"><span>Counts toward</span>
              <select value={m ? m.id : ""} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => planApi.place(t.item, { milestone: e.target.value || null })}>
                <option value="">Nothing in particular</option>
                {plan.milestones.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select></label>
            {t.file || t.origin ? <div className="bp-field"><span>Original</span>
              {t.origin ? <a className="bp-orig" href={t.origin} target="_blank" rel="noreferrer">{t.file || t.origin} ↗</a> : <em className="bp-orig">{t.file}</em>}</div> : null}
          </div>
          <div>
            <h2>{g ? "Also in " + g.name : plan.groups.length ? "Also ungrouped" : "Also on this board"}</h2>
            {mates.length ? mates.map((x) => srcRow(x)) : <div className="bp-faint">Nothing else here yet.</div>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={"desk bp" + (over ? " over" : "") + (current && !choosing ? " has-sel" : "")}>
      <div className="bp-grid">
        {rail}
        <main className="bp-main" ref={leftRef}>
          {choosing ? bulk() : current ? cover(current) : front()}
        </main>
      </div>
      <div className="dk-foot">
        <span>{over
          ? <><kbd>esc</kbd> back to the card · <kbd>b</kbd> all boards</>
          : <><kbd>h</kbd> this page, from anywhere · <kbd>b</kbd> all boards</>}</span>
      </div>
    </div>
  );
}
