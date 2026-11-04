import { useEffect, useState, type CSSProperties } from "react";
import { StrataAPI } from "../../data/api.ts";
import { cacheGet, cachePut, useThumb } from "../../engines/pdf/thumbnails.ts";

export function useSourceThumb(boardId: string | null | undefined, rid: string | null | undefined, page: number, want: boolean): string | null {
  return useThumb(boardId && rid ? StrataAPI.resourceRawUrl(boardId, rid) : null, rid, page, want);
}

const lineMem = new Map<string, string[]>();
async function coverLines(boardId: string, rid: string): Promise<string[]> {
  if (lineMem.has(rid)) return lineMem.get(rid)!;
  const key = rid + "@lines";
  let rec = await cacheGet<{ lines?: string[]; at: number }>(key);
  if (!rec) {
    try {
      const { lines } = await StrataAPI.resourcePreview(boardId, rid);
      rec = { lines, at: Date.now() };
      await cachePut(key, rec);
    } catch (e) { rec = { lines: [], at: Date.now() }; }
  }
  lineMem.set(rid, rec.lines || []);
  return rec.lines || [];
}

function useLines(boardId: string | null | undefined, rid: string | null | undefined, want: boolean): string[] | null {
  const [lines, setLines] = useState<string[] | null>(() => (rid ? lineMem.get(rid) : null) || null);
  useEffect(() => {
    if (!rid || !boardId || !want || lineMem.has(rid)) return;
    let dead = false;
    void coverLines(boardId, rid).then((l) => { if (!dead) setLines(l); });
    return () => { dead = true; };
  }, [boardId, rid, want]);
  return lines;
}

export function hueOf(s: string | null | undefined): number { let h = 0; for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s!.charCodeAt(i)) % 360; return h; }

export interface CoverProps {
  boardId?: string | null; rid?: string | null; kind?: string; title?: string; sub?: string; want?: boolean;
  text?: string;
}

export default function SourceCover({ boardId, rid, kind, title, sub, want, text }: CoverProps) {
  const fetched = useLines(boardId, rid, !!want && !text && (kind === "text" || kind === "transcript" || kind === "article"));
  const lines = text
    ? String(text).split("\n").map((l) => l.replace(/^#+\s*/, "").replace(/[*_`>[\]]/g, "").trim()).filter((l) => l.length > 2).slice(0, 6)
    : fetched;
  const h = hueOf(rid || title || "");
  return (
    <div className={"cover c-" + (kind || "blank")} style={{ "--h": h } as CSSProperties}>
      <div className="cv-kind">{sub || kind || ""}</div>
      <div className="cv-title">{(title || "untitled").replace(/\.[^.]+$/, "")}</div>
      {lines && lines.length
        ? <div className="cv-lines">{lines.slice(1, 5).map((l, i) => <span key={i}>{l}</span>)}</div>
        : <div className="cv-rules"><i /><i /><i /><i /></div>}
    </div>
  );
}
