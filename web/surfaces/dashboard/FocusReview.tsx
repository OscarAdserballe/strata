import { useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useArchive, useDashBoard, type DashLink, type DashTask } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import { go } from "./nav.ts";
import { Notes, Src, hm, newThreadId } from "./parts.tsx";
import { move } from "./moves.ts";

const ICON: Record<string, string> = { github: "PR", linear: "LN", slack: "SL", notion: "NO", web: "WEB", claude: "CC", strata: "ST" };
function linkOf(raw: string): DashLink | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  const kind = /github\.com$/.test(host) ? "github" : /linear\.app$/.test(host) ? "linear" : /slack\.com$/.test(host) ? "slack"
    : /notion\.(so|site|com)$/.test(host) ? "notion" : /claude\.ai$/.test(host) ? "claude" : "web";
  const parts = u.pathname.split("/").filter(Boolean);
  const ref = kind === "github" && parts.length >= 4 ? `${parts[0]}/${parts[1]}#${parts[3]}` : parts.length ? parts[parts.length - 1].slice(0, 80) : host;
  return { kind, ref, url: u.href };
}

/** Focus's Review: threads of your own that came back, with what was made for them; Dispatch keeps its own. */
export default function FocusReview() {
  const board = useDashBoard();
  const list = (board?.tasks ?? []).filter((t) => t.stage === "review" && !t.dispatched).sort((a, b) => b.updatedAt - a.updatedAt);
  const [sel, setSel] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const archive = useArchive(doneOpen);
  const t = list.find((x) => x.id === sel) ?? list[0] ?? null;
  const ended = [...(board?.tasks ?? []).filter((x) => x.stage === "done" || x.stage === "dropped"), ...(archive ?? [])]
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
  return (
    <div className="ws">
      <aside className="ws-list" aria-label="Ready for you">
        {list.map((x) => <button key={x.id} className={"ws-card" + (t?.id === x.id ? " on" : "")} onClick={() => setSel(x.id)}>
          <span className="t">{x.title}</span><span className="m">since {hm(x.updatedAt)}{x.links.length ? ` · ${x.links.length} link${x.links.length > 1 ? "s" : ""}` : ""}</span></button>)}
        {!list.length ? <p className="ws-none">Nothing waiting. A thread comes here from Thinking when Claude has made something for it.</p> : null}
        <button className="ws-fold" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>{doneOpen ? "▾" : "▸"} Done{board ? ` · ${board.archived + ended.length}` : ""}</button>
        {doneOpen ? ended.map((x) => <div key={x.id} className="ws-done"><span>{x.title}</span><i>{x.stage === "dropped" ? "dropped" : "done"}</i>
          <button className="btn quiet small" onClick={() => dash.patch(x.id, { cleared: false, stage: "backlog" }, (y) => ({ ...y, stage: "backlog", clearedAt: null })).then(() => toast("Back in the backlog"), (e) => toast(StrataWhy(e, "not restored"), 4200))}>Back</button></div>) : null}
      </aside>
      <div className="ws-room">
        <div className="ws-caption">{t ? <span>Ready for you · since {hm(t.updatedAt)}</span> : <span />}</div>
        <div className="ws-sheet">{t ? <Panel key={t.id} t={t} /> : <div className="ws-blank"><p>Nothing to review.</p></div>}</div>
      </div>
    </div>
  );
}

function Panel({ t }: { t: DashTask }) {
  const [link, setLink] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const links = (next: DashLink[]) => dash.patch(t.id, { links: next }, (x) => ({ ...x, links: next })).catch((e) => toast(StrataWhy(e, "not saved"), 4200));
  return (
    <article className="doc review">
      <div className="doc-crumb"><Src from={t.createdFrom} />{t.area === "personal" ? <span className="tag">personal</span> : null}</div>
      <h1 className="dtitle static">{t.title}</h1>
      <div className="arts">
        {t.links.map((l, i) => <div key={i} className="art">
          <span className={`ic ${l.kind}`}>{ICON[l.kind] ?? l.kind.slice(0, 3)}</span>
          <span className="am"><b>{l.ref}{l.title ? ` · ${l.title}` : ""}</b><i>{l.url ? l.url.replace(/^https?:\/\//, "") : l.kind}</i></span>
          {l.url ? <a href={l.url} target="_blank" rel="noopener">Open ↗</a> : null}
          <button className="btn quiet small" aria-label="Remove link" onClick={() => void links(t.links.filter((_, n) => n !== i))}>×</button>
        </div>)}
        <form className="addlink" onSubmit={(e) => { e.preventDefault(); const l = linkOf(link.trim()); if (!l) { toast("Paste a full link"); return; } setLink(""); toast("Link added"); void links([...t.links, l]); }}>
          <input id="linkIn" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a PR, explainer or test run link…" aria-label="Add a link" autoComplete="off" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>
      {t.body.trim() ? <div className="fold">
        <button className="cap" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>{notesOpen ? "▾" : "▸"} Your notes</button>
        {notesOpen ? <Notes text={t.body} /> : null}
      </div> : null}
      <div className="doc-foot">
        <button className="btn dark" onClick={() => move(t, "done")}>Done</button>
        <button className="btn" onClick={() => {
          const id = newThreadId();
          dash.create({ id, title: `Follow-up: ${t.title}`, area: t.area, links: [{ kind: "strata", ref: t.id, title: t.title }] })
            .then(() => toast("A follow-up is in the backlog"), (e) => toast(StrataWhy(e, "not added"), 4200));
          go({ view: "triage", sub: "backlog" });
        }}>New thread from this…</button>
        <span className="grow" />
        <button className="btn quiet" onClick={() => move(t, "dropped")}>Drop</button>
      </div>
    </article>
  );
}
