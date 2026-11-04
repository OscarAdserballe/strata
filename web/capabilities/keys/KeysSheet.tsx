import { useEffect, useState } from "react";
import { closeKeysSheet, sheetNow, useKeysSheetOpen } from "./registry.ts";

// the sheet's words load on first open; nobody reads them on the way into a board
type Sheets = typeof import("./sheets.ts");
let loaded: Sheets | null = null;

export default function KeysSheet() {
  const open = useKeysSheetOpen();
  const [sheets, setSheets] = useState<Sheets | null>(loaded);
  useEffect(() => {
    if (open && !sheets) void import("./sheets.ts").then((m) => { loaded = m; setSheets(m); });
  }, [open, sheets]);
  if (!open || !sheets) return null;
  const { groups, foot } = sheetNow(sheets.SHEETS, sheets.EVERYWHERE);
  return (
    <div className="veil keys-veil" onClick={(e) => { if (e.target === e.currentTarget) closeKeysSheet(); }}>
      <div className="keys-sheet">
        <div className="ks-head">keys <span className="k">any key closes this</span></div>
        <div className="ks-body">
          {groups.map(([title, rows]) => (
            <div className="ks-group" key={title}>
              <div className="ks-title">{title}</div>
              {rows.map(([k, what]) => <div className="ks-row" key={k}><kbd>{k}</kbd><span>{what}</span></div>)}
            </div>
          ))}
        </div>
        {foot ? <div className="ks-foot">{foot}</div> : null}
      </div>
    </div>
  );
}
