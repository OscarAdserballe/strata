/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type ReactNS from "react";
import type { createPortal as Portal } from "react-dom";
import type { StrataAPI } from "../../data/api.ts";
import { S } from "../../shell/atoms.tsx";
import type { CaptureState, Landed, SetCapture, Target } from "./AddSource.tsx";
import { press, tell } from "./capture-key.ts";

// imports nothing the main bundle imports, or esbuild would hoist it into a chunk every boot loads
export interface CaptureHost {
  React: typeof ReactNS; createPortal: typeof Portal;
  api: Pick<typeof StrataAPI, "capture" | "captureFinish" | "log">;
  resolve(board: Target): Promise<string | null>;
  set: SetCapture;
  now(): CaptureState | null;
  added(): void;
  landed(r: Landed, message: string | null): void;
}
let host = null as unknown as CaptureHost;
let React = null as unknown as typeof ReactNS, createPortal = null as unknown as typeof Portal;
export function bind(h: CaptureHost) { host = h; React = h.React; createPortal = h.createPortal; }

export interface CaptureProps {
  cap: CaptureState;
  onClose: () => void;
  toast: (message: string) => void;
}

// a press writes only into its own dialog: a late answer must not touch a newer one
type Step = (c: CaptureState) => CaptureState;
const inDialog = (d: object, step: Step) => host.set((c) => (c.dialog === d ? step(c) : c));
const up = (d: object) => host.now()?.dialog === d;
function land(d: object, key: string, r: Landed, message: string) {
  if (up(d)) host.set(null);
  host.added();
  host.landed(r, tell(key) ? message : null);
}
function gone(answer: unknown): boolean {
  const r = answer as { resourceId?: string; state?: { resources?: { id: string }[] } } | null;
  return !!r?.resourceId && Array.isArray(r.state?.resources) && !r.state.resources.some((x) => x.id === r.resourceId);
}

function captionsStep(boardId: string, r: { url: string; title?: string | null; author?: string | null; why?: string | null; ytDlpCommand?: string; ytDlpCommands?: Record<string, string> }, dialog: object = {}): void {
  host.set({
    boardId, step: "captions", url: r.url, title: r.title || "", author: r.author || "", why: r.why || "", cmd: r.ytDlpCommand, commands: r.ytDlpCommands,
    platform: /Win/i.test(navigator.platform) ? "windows" : "macos", vtt: "", busy: false, error: "", dialog,
  });
}

export async function submitUrl() {
  const c = host.now();
  const url = (c?.url || "").trim();
  if (!c || !url || c.busy) return;
  const d = c.dialog;
  inDialog(d, (x) => ({ ...x, busy: true, error: "" }));
  try {
    const id = await host.resolve(c.boardId);
    if (!id) throw new Error("there is no board to add it to");
    host.api.log("capture_submit", { board: id });
    const link = { url };
    const { r, key } = await press("capture", id, link, link, (k) => host.api.capture(id, url, k), gone);
    // a video whose transcript the room couldn't read is handed back to you, to fetch its captions yourself
    if (r.kind === "youtube") { if (up(d)) captionsStep(id, r, d); return; }
    land(d, key, r, (r.title || (r.kind === "transcript" ? "the talk" : "the article")) + " — added");
  } catch (e) { inDialog(d, (x) => ({ ...x, busy: false, error: (e as Error).message })); }
}

export async function submitCaptions() {
  const c = host.now();
  if (!c || c.busy || !(c.vtt || "").trim()) return;
  const d = c.dialog;
  inDialog(d, (x) => ({ ...x, busy: true, error: "" }));
  try {
    const id = await host.resolve(c.boardId);
    if (!id) throw new Error("there is no board to add it to");
    // keyed by link and captions only: the title this dialog's fetch read may differ from the first
    const { r, key, body } = await press("capture/finish", id, { url: c.url, vtt: c.vtt }, { url: c.url, title: c.title, author: c.author, vtt: c.vtt },
      (k, b) => host.api.captureFinish(id, b, k), gone);
    land(d, key, { ...r, title: body.title }, (body.title || "the talk") + " — " + r.cues + " cues");
  } catch (e) { inDialog(d, (x) => ({ ...x, busy: false, error: (e as Error).message })); }
}

export async function saveLink(board: Target, url: string): Promise<"added" | "captions"> {
  const id = await host.resolve(board);
  if (!id) throw new Error("there is no board to add it to");
  const link = { url };
  const { r } = await press("capture", id, link, link, (k) => host.api.capture(id, url, k), gone);
  if (r && r.kind === "youtube") {
    if (host.now()) throw new Error("the link dialog is open: finish it, then save this link again");
    captionsStep(id, r);
    return "captions";
  }
  host.added();
  return "added";
}


function Capture({ cap, onClose, toast }: CaptureProps) {
  const set = host.set;
  const onCaptions_ = cap.step === "captions";
  const windows = cap.platform === "windows";
  const command = cap.commands?.[windows ? "windows" : "macos"] || cap.cmd || "";
  const setup = windows ? "winget install --id yt-dlp.yt-dlp -e\nwinget install --id DenoLand.Deno -e" : "brew install yt-dlp deno";
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast("command copied"); }
    catch { toast("select and copy the command"); }
  }
  return createPortal(
    <div className="veil capture-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cap" role="dialog" aria-modal="true" aria-labelledby="capture-heading">
        <div className="cap-head" id="capture-heading">
          {onCaptions_ ? "capture · the captions" : "capture · a link"}
          <span className="k"><kbd>esc</kbd> cancel</span>
        </div>
        <div className="cap-body">
          {!onCaptions_ ? <>
            <input autoFocus value={cap.url} disabled={cap.busy} placeholder="paste a youtube or article link…"
              onChange={(e) => set((x) => ({ ...x, url: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void submitUrl(); if (e.key === "Escape") onClose(); }} />
            <div className="note">{cap.busy
              ? "fetching… a long video can take a minute; you can close this and it still lands."
              : "It lands on this board as a source you can read — nothing is summarised."}</div>
          </> : <>
            <div>
              <div className="title">{cap.title}</div>
              {cap.author ? <div className="by">{cap.author}</div> : null}
            </div>
            {cap.why ? <div className="note" role="status">{cap.why}</div> : null}
            <div role="group" aria-label="Your computer">
              <button style={S.ghost} aria-pressed={!windows} onClick={() => set(x => ({ ...x, platform: "macos" }))}>Mac</button>
              <button style={S.ghost} aria-pressed={windows} onClick={() => set(x => ({ ...x, platform: "windows" }))}>Windows</button>
            </div>
            <div className="note">Open {windows ? "PowerShell" : "Terminal"}, paste and run the command below. It downloads English captions, copies them to your clipboard, and removes its temporary files. Then return here and paste with {windows ? "Ctrl+V" : "⌘V"}.</div>
            <details>
              <summary>First time? Set up yt-dlp</summary>
              <p className="note">yt-dlp fetches the captions; Deno helps it read YouTube. Run this once in {windows ? "PowerShell" : "Terminal"}, then close and reopen it.</p>
              {windows ? <p className="note">If winget is missing, install or update <a href="https://apps.microsoft.com/detail/9nblggh4nns1" target="_blank" rel="noreferrer">App Installer</a> from Microsoft Store.</p>
                : <p className="note">If brew is missing, follow the installation instructions at <a href="https://brew.sh" target="_blank" rel="noreferrer">brew.sh</a> first.</p>}
              <pre className="cmd">{setup}</pre>
              <button style={S.ghost} onClick={() => copy(setup)}>Copy setup commands</button>
              <p className="note">Check with <code>yt-dlp --version</code> and <code>deno --version</code>. Both should print a version number.</p>
            </details>
            <pre className="cmd">{command}</pre>
            <button style={S.ghost} onClick={() => copy(command)}>Copy caption command</button>
            <textarea autoFocus value={cap.vtt} disabled={cap.busy} placeholder="Paste the captions here…"
              onChange={(e) => set((x) => ({ ...x, vtt: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitCaptions(); }} />
          </>}
          {cap.error ? <div className="err">{cap.error}</div> : null}
          <div className="row">
            <span className="grow" />
            <button style={S.ghost} onClick={onClose}>cancel</button>
            <button style={S.prim} disabled={cap.busy} onClick={() => void (onCaptions_ ? submitCaptions() : submitUrl())}>
              {cap.busy ? "working…" : onCaptions_ ? "add the transcript" : "fetch it"}
            </button>
          </div>
        </div>
      </div>
    </div>, document.body
  );
}

export default Capture;
