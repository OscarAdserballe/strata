import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StrataWhy } from "../../data/api.ts";
import { agents, useAgentTokens } from "../../data/entities/agents.ts";

type PanelChunk = typeof import("./ConnectPanel.tsx");
let loading: Promise<PanelChunk> | null = null;
// The panel loads on first open, so the Desk's bundle carries only this button.
const loadPanel = () => (loading ??= import("./ConnectPanel.tsx").then(
  (m) => { m.bind({ React, StrataWhy, agents, useAgentTokens }); return m; },
  (e) => { loading = null; throw e; },
));

export default function ConnectAgent() {
  const [open, setOpen] = useState(false);
  const [Panel, setPanel] = useState<PanelChunk["default"] | null>(null);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) { if (!dialog.current?.open) dialog.current?.showModal(); } else dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open || Panel) return;
    let live = true;
    loadPanel().then((m) => { if (live) setPanel(() => m.default); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [open, Panel]);
  return <>
    <button className="home-quiet" onPointerDown={() => void loadPanel().catch(() => {})} onClick={() => { setFailed(false); setOpen(true); }}>Connect an agent</button>
    {createPortal(<dialog className="home-tool-dialog" ref={dialog} aria-labelledby="connect-agent-title"
      onCancel={() => setOpen(false)} onKeyDown={(e) => e.stopPropagation()}>
      <header><h2 id="connect-agent-title">Connect an agent</h2>
        <button aria-label="Close" onClick={() => setOpen(false)}>✕</button></header>
      {!open ? null : Panel ? <Panel /> : <p className="home-tool-note">{failed ? "Couldn't load this panel. Close it and try again." : "Loading…"}</p>}
    </dialog>, document.body)}
  </>;
}
