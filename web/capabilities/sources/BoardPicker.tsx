import { Fragment, useSyncExternalStore } from "react";
import { store as roomStore } from "../../data/store.ts";
import { BOARDS } from "../../data/entities/sources.ts";
import { useBoardList } from "../../data/entities/register.ts";
import type { BoardListEntry } from "../../../shared/types/index.ts";
import { addSource, tellSources, watchSources } from "./AddSource.tsx";

// held here, not in the board route, so an arrow key renders the picker and not the room

export interface PickerItem {
  label: string; meta?: string; group?: string; cur?: boolean;
  keepOpen?: boolean;
  run(): void;
}
export type Picker = { items: PickerItem[]; sel: number };

let open: Picker | null = null;
export const pickerNow = (): Picker | null => open;
export function setPicker(next: Picker | null | ((was: Picker) => Picker | null)): void {
  open = typeof next === "function" ? (open ? next(open) : null) : next;
  tellSources();
}

export function addSourceFrom(kind: "file" | "link", at: { activeId: string | null; libraryUp: boolean; newBoard(title: string): Promise<{ id: string } | undefined> }, study = true): void {
  const add = (kind: "file" | "link", board: string | null) => (kind === "link" ? addSource.link(board) : addSource.file(board, study));
  if (at.activeId && !at.libraryUp) { add(kind, at.activeId); return; }
  const bs = roomStore.get<BoardListEntry[]>(BOARDS) || [];
  const what = kind === "link" ? "the link" : "the file";
  const items: PickerItem[] = bs.map((b) => ({
    group: "add " + what + " to", label: b.title,
    meta: (b.resources || []).length + " source" + ((b.resources || []).length === 1 ? "" : "s"),
    cur: b.id === at.activeId,
    run: () => add(kind, b.id),
  }));
  items.push({ group: "or", label: "+ a new board", meta: "named after the source, until you rename it",
    run: () => { void at.newBoard("").then((b) => { if (b) add(kind, b.id); }); } });
  setPicker({ items, sel: 0 });
}

function BoardPicker({ go }: { go: Picker }) {
  let lastGroup = "";
  const close = () => setPicker(null);
  return (
    <div className="veil" onClick={(e) => { if ((e.target as HTMLElement).className === "veil") close(); }}>
      <div className="go">
        <div className="go-head">go <span className="k"><kbd>↑↓</kbd> pick · <kbd>↵</kbd> open · <kbd>m</kbd> move · <kbd>esc</kbd> back</span></div>
        <div className="go-body">
          {go.items.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group as string) : null;
            return <Fragment key={i}>
              {head ? <div className="go-group">{head}</div> : null}
              <div className={"go-row" + (i === go.sel ? " sel" : "") + (it.cur ? " cur" : "")}
                onMouseEnter={() => setPicker((x) => ({ ...x, sel: i }))} onClick={() => { if (!it.keepOpen) close(); it.run(); }}>
                <span className="mono">{i === go.sel ? "▸" : ""}</span>
                <span className="name">{it.label}</span>
                <span className="meta">{it.meta}</span>
              </div>
            </Fragment>;
          })}
        </div>
      </div>
    </div>
  );
}

export function BoardPickerHost() {
  useBoardList();
  const go = useSyncExternalStore(watchSources, pickerNow, pickerNow);
  return go ? <BoardPicker go={go} /> : null;
}
