import { ago } from "../../shell/format.js";
import SourceVerbs from "../../capabilities/sources/SourceVerbs.tsx";
import RenameBox, { useRename } from "../../capabilities/sources/RenameBox.tsx";
import SourceCover, { useSourceThumb } from "./SourceCover.tsx";
import type { Tile } from "./boardTiles.ts";

export interface ChapterVerbs {
  onDel?: ((t: Tile) => void) | null;
  onAside?: ((t: Tile, restore: boolean) => void) | null;
  onDistil?: ((t: Tile) => void) | null;
  onKeep?: ((t: Tile) => void) | null;
  onKeepWarm?: (() => void) | null;
  onRenamed?: ((t: Tile, name: string) => void) | null;
  onDone?: ((t: Tile, done: boolean) => void) | null;
}

const Busy = ({ t }: { t: Tile }) => (t.busy ? <span className="dk-spin" title="the model is reading this in — its tree and cards are on the way" /> : null);
const Done = ({ t }: { t: Tile }) => (t.doneAt ? <span className="dk-done" title={"marked done " + ago(t.doneAt)}>✓</span> : null);

function ChapterRow({ t, onOpen, onDel, onAside, onDistil, onKeep, onKeepWarm, onRenamed, onDone }: { t: Tile; onOpen: (t: Tile) => void } & ChapterVerbs) {
  const url = useSourceThumb(t.boardId, t.pdf ? t.rid : null, t.page || 1, !!t.pdf);
  const rn = useRename(t, onRenamed);
  return (
    <div className={"dk-row" + (t.cur ? " cur" : "") + (t.dim ? " dim" : "")}>
      <button className="dk-hit" title={t.title || t.label} onClick={() => { if (!rn.renaming) onOpen(t); }}>
        <span className="dk-thumb">
          {url
            ? <img src={url} alt="" draggable="false" />
            : <SourceCover boardId={t.boardId} rid={t.rid} kind={t.kind} title={t.cvTitle || t.label} sub={t.cover} want={false} text={t.text} />}
        </span>
        <span className="dk-rtext">
          {rn.renaming
            ? <RenameBox draft={rn.draft} setDraft={rn.setDraft} onCommit={rn.commit} onCancel={rn.cancel} cls="dk-rename" />
            : <span className="dk-rlabel">{t.label}</span>}
          {t.meta ? <span className="dk-rmeta">{t.meta}</span> : null}
        </span>
        <span className="dk-rside">
          <Busy t={t} />
          <Done t={t} />
          {t.kp
            ? t.kp.benched
              ? <span className="dk-star on" title={"kept " + t.kp.kept + " of " + t.kp.total}>★{t.kp.kept}</span>
              : <span className="dk-star" title="never curated — this deck hasn't met the bench yet">☆</span>
            : null}
          {t.read ? <span className={"dk-dot " + t.read} /> : null}
        </span>
      </button>
      <SourceVerbs t={t} onDel={onDel} onAside={onAside} onDistil={onDistil} onKeep={onKeep} onKeepWarm={onKeepWarm} onRename={rn.start} onDone={onDone} />
    </div>
  );
}

export interface BookRoomProps extends ChapterVerbs {
  tiles: Tile[];
  onOpen: (t: Tile) => void;
  head: string;
  over: boolean;
  onBack: () => void;
}

export default function BookRoom({ tiles, onOpen, head, over, onBack, ...verbs }: BookRoomProps) {
  const gap = tiles.find((t) => t.gap);
  if (!gap) return null;
  const chapters = tiles.filter((t) => !t.gap);
  return (
    <div className={"desk" + (over ? " over" : "")}>
      <div className="dk-top">
        <button className="dk-crumb" onClick={() => onOpen(gap)} title="back to everything on this board">‹ {head}</button>
        <span className="grow" />
        {over ? <button className="dk-back" onClick={onBack} title="back to the card (esc)">the card ›</button> : null}
      </div>
      <div className="dk-bookname">{gap.gap}</div>
      <div className="dk-chapters">
        {chapters.map((t) => <ChapterRow key={t.key} t={t} onOpen={onOpen} {...verbs} />)}
      </div>
      <div className="dk-foot"><span><kbd>esc</kbd> back · <kbd>b</kbd> all boards</span></div>
    </div>
  );
}
