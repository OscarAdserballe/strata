import type { CSSProperties } from "react";

const S: Record<"ghost" | "prim", CSSProperties> = {
  ghost: { font: "500 12px/1 var(--sans)", padding: "7px 11px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card-bg)", color: "var(--ink-soft)", cursor: "pointer", whiteSpace: "nowrap" },
  prim: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, font: "500 13px/1 var(--sans)", padding: "10px 14px", borderRadius: 9, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer" },
};

export { S };
