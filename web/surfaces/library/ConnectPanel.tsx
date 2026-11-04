/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type ReactNS from "react";
import type { StrataWhy as Why } from "../../data/api.ts";
import type { agents as Agents, useAgentTokens as UseTokens } from "../../data/entities/agents.ts";

// lazy chunk: import only types, or esbuild hoists shared code into the boot bundle; deps come via bind()
export interface ConnectHost { React: typeof ReactNS; StrataWhy: typeof Why; agents: typeof Agents; useAgentTokens: typeof UseTokens }
let React = null as unknown as typeof ReactNS, StrataWhy = null as unknown as typeof Why;
let agents = null as unknown as typeof Agents, useAgentTokens = null as unknown as typeof UseTokens;
export function bind(host: ConnectHost) { ({ React, StrataWhy, agents, useAgentTokens } = host); }
const useRef: typeof ReactNS.useRef = (v?: any) => React.useRef(v), useState: typeof ReactNS.useState = (v?: any) => React.useState(v);

const day = (t: number | null) => t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never";

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch {   // no clipboard over plain http: select it for ⌘C instead
      const range = document.createRange(); if (pre.current) range.selectNodeContents(pre.current);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    }
  }
  return <div className="agent-snippet">
    <div><span>{label}</span><button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
    <pre ref={pre}>{text}</pre>
  </div>;
}

export default function ConnectPanel() {
  const list = useAgentTokens();
  const [name, setName] = useState("Claude Code");
  const [write, setWrite] = useState(true);
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = list ? `${location.origin}${list.mcpPath}` : "";
  async function make(e: ReactNS.FormEvent) {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try { const r = await agents.create(name.trim() || "agent", write); setMade({ token: r.token, name: name.trim() || "agent" }); }
    catch (err) { setError(StrataWhy(err, "Couldn't make a token")); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setError("");
    try { await agents.revoke(id); } catch (err) { setError(StrataWhy(err, "Couldn't revoke that token")); }
  }
  return <div className="home-tool-form">
    <p className="home-tool-note">Claude Code and Codex can read this room (your boards, kept cards, questions, highlights and sources) and add files, questions and log lines to it. Each agent gets its own token, which you can revoke here.</p>
    {error ? <p role="alert">{error}</p> : null}
    {made ? <>
      <p role="status">Token for <b>{made.name}</b>. It's shown only now: copy it into your agent before closing.</p>
      <Snippet label="Claude Code (run once in a terminal)" text={`claude mcp add -s user --transport http strata ${url} --header "Authorization: Bearer ${made.token}"`} />
      <Snippet label="Codex (~/.codex/config.toml)" text={`[mcp_servers.strata]\nurl = "${url}"\nbearer_token_env_var = "STRATA_TOKEN"`} />
      <Snippet label="…and in your shell profile" text={`export STRATA_TOKEN=${made.token}`} />
      <button type="button" onClick={() => setMade(null)}>Done</button>
    </> : <form className="home-tool-form" onSubmit={make}>
      <label htmlFor="agent-name">Name it after where it runs</label>
      <input id="agent-name" value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} />
      <label className="agent-check"><input type="checkbox" checked={write} disabled={busy} onChange={(e) => setWrite(e.target.checked)} /> Can add files, questions and log lines (otherwise read-only)</label>
      <button type="submit" disabled={busy}>{busy ? "Making…" : "Make a token"}</button>
    </form>}
    <h3 className="agent-heading">Connected agents</h3>
    {!list ? <p className="home-tool-note">Loading…</p> : !list.tokens.length ? <p className="home-tool-note">None yet.</p> :
      <ul className="agent-tokens">{list.tokens.map((t) => <li key={t.id}>
        <span><b>{t.name}</b> · {t.scopes.includes("write") ? "read and write" : "read-only"} · made {day(t.created_at)} · last used {day(t.last_used_at)}</span>
        <button type="button" onClick={() => revoke(t.id)}>Revoke</button>
      </li>)}</ul>}
  </div>;
}
