/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type ReactNS from "react";
import type { SessionMapResponse, SessionTopic } from "../../../shared/types/index.ts";
import type { courseOf as CourseOf } from "../../shell/format.js";
import type { StrataAPI as API } from "../../data/api.ts";
import type { default as ClaimTreeT, Line as LineT, Met as MetT } from "../../engines/tree/ClaimTree.tsx";

// lazy chunk: import only types, or esbuild hoists shared code into the boot bundle; deps come via bind()
export interface SessionMapHost {
  React: typeof ReactNS; PHONE: boolean; courseOf: typeof CourseOf; StrataAPI: typeof API;
  ClaimTree: typeof ClaimTreeT; Line: typeof LineT; Met: typeof MetT;
}
let React = null as unknown as typeof ReactNS, PHONE = false, courseOf = null as unknown as typeof CourseOf, StrataAPI = null as unknown as typeof API,
  ClaimTree = null as unknown as typeof ClaimTreeT, Line = null as unknown as typeof LineT, Met = null as unknown as typeof MetT;
export function bind(host: SessionMapHost) { ({ React, PHONE, courseOf, StrataAPI, ClaimTree, Line, Met } = host); }
// the host's React, so hooks share one instance
const useState: typeof ReactNS.useState = (v?: any) => React.useState(v), useEffect: typeof ReactNS.useEffect = (...a) => React.useEffect(...a), useRef: typeof ReactNS.useRef = (v?: any) => React.useRef(v);

export interface SessionMapProps {
  onClose: () => void;
  onOpen?: ((at: { board: string; resource?: string | null }) => void) | null;
  left: number;
  when?: string;
}


// local midnight: the server can't know the reader's timezone
export const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

function Tile({ t, onJump }: { t: SessionTopic; onJump: (course: string) => void }) {
  return (
    <button className={"smtile" + (t.missed ? " miss" : "")} onClick={() => onJump(t.course)}>
      <span className="smtname">{t.label || t.courseTitle}</span>
      {t.boardTitle ? <span className="smtboard">{courseOf(t.boardTitle)}</span> : null}
      <span className="smttally">
        {t.missed ? <span className="smmiss">✗ {t.missed}</span> : null}
        <span className="smgot">✓ {t.got}</span>
        {t.dueLeft ? <span className="smtdue">{t.dueLeft} due</span> : null}
      </span>
    </button>
  );
}

function Topic({ t, onOpen, hold }: { t: SessionTopic; onOpen: SessionMapProps["onOpen"]; hold: (el: HTMLElement | null) => void }) {
  const claims = t.tree ? t.tree.claims : [];
  const visited = claims.filter((c) => c.met.length).length;
  return (
    <section className="smtopic" ref={hold}>
      <div className="smhead">
        <span className="smname">{t.label || t.courseTitle}</span>
        <span className="grow" />
        <span className="smtally">
          {t.missed ? <span className="smmiss">{t.missed} missed</span> : null}
          <span className="smgot">{t.got} got</span>
        </span>
      </div>
      {t.boardTitle ? <div className="smboard">{PHONE ? courseOf(t.boardTitle) : t.boardTitle}</div> : null}
      <div className="smcover">
        {t.met} of {t.deckTotal} cards met{t.dueLeft ? ` · ${t.dueLeft} still due here` : " · none left due"}
        {t.tree ? ` · ${visited} of ${claims.length} claims visited` : ""}
      </div>
      {t.tree && t.tree.question ? <div className="smq-root"><Line text={t.tree.question} max={PHONE ? 110 : 180} /></div> : null}

      <ClaimTree claims={claims} />
      {t.loose.length ? (
        <div className="smloose">
          <div className="smloosel">{t.tree ? "not under any claim of this tree" : "an authored deck — no tree behind it"}</div>
          {t.loose.map((m) => <Met key={m.card} m={m} />)}
        </div>
      ) : null}

      {t.board && onOpen ? (
        <div className="smrow">
          <button className="smopen" onClick={() => onOpen(t as SessionTopic & { board: string })}>open {PHONE ? "the source" : "where this lives"} →</button>
        </div>
      ) : null}
    </section>
  );
}

function SessionMap({ onClose, onOpen, left, when }: SessionMapProps) {
  const [map, setMap] = useState<SessionMapResponse | null>(null);
  const [error, setError] = useState(false);
  const spots = useRef<Record<string, HTMLElement | null>>({});
  // not scrollIntoView or smooth scrolling: both do nothing under the room's CSS zoom
  const jump = (course: string) => {
    const el = spots.current[course];
    if (!el) return;
    const box = el.closest<HTMLElement>(".rwrap");
    if (box) box.scrollTop = el.offsetTop - 12; else el.scrollIntoView();
  };

  useEffect(() => {
    StrataAPI.reviewSession(midnight()).then(setMap).catch(() => setError(true));
  }, []);

  if (error) return <div className="rdone"><div className="rdone-line">couldn’t draw the map — the wire may be down</div>
    <button className="lask-go" onClick={onClose}>{PHONE ? "done" : "back to the boards"}</button></div>;
  if (!map) return null;

  if (!map.cards) return (
    <div className="rdone">
      <div className="rdone-mark">✓</div>
      <div className="rdone-line">nothing reviewed today</div>
      <button className="lask-go" onClick={onClose}>{PHONE ? "done" : "back to the boards"}</button>
    </div>
  );

  return (
    <div className="smap">
      <div className="smtop">
        <span className="smcount">{map.cards}</span>
        <span className="smunit">cards today</span>
        <span className="smfacts">
          {map.missed ? <>{map.got} got · <span className="smmiss">{map.missed} missed</span></> : <>all {map.got} got</>}
          {map.minutes ? ` · ${map.minutes} min` : ""}
          {map.sittings > 1 ? ` · ${map.sittings} sittings` : ""}
        </span>
      </div>
      <div className="smleft">
        {left ? `${left} left in this sitting · ` : ""}
        {map.dueLeft ? `${map.dueLeft} still due` : when ? `next cards ${when}` : "nothing else due"}
      </div>

      <div className="smgrid">
        {map.topics.map((t) => <Tile key={t.course} t={t} onJump={jump} />)}
      </div>

      {map.topics.map((t) => (
        <Topic key={t.course} t={t} onOpen={onOpen} hold={(el) => { spots.current[t.course] = el; }} />
      ))}

      <div className="smfoot">
        <button className="lask-go" onClick={onClose}>{PHONE ? "done" : "back to the boards"}</button>
      </div>
    </div>
  );
}

export default SessionMap;
