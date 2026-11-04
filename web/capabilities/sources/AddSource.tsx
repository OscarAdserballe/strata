import React, { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { addImports } from "./imports.ts";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { store } from "../../data/store.ts";
import { BOARDS, REGISTER, sources } from "../../data/entities/sources.ts";
import type { BoardState } from "../../../shared/types/index.ts";
// capture is a direct request, not a save-path op: a refusal must show at once, not after retries

export const UNFILED = "unfiled";
export type Target = string | null;

export interface CaptureState {
  boardId: Target; step: "url" | "captions"; url: string; vtt: string; busy: boolean; error: string;
  title?: string; author?: string; why?: string; cmd?: string; commands?: Record<string, string>; platform?: string;
  /** identifies this dialog: a press acts only on the dialog it was made in */
  dialog: object;
}
export interface Landed { state: BoardState; resourceId: string; title?: string }
interface Hooks {
  current(): string | null;
  landed(r: Landed, message: string | null): void;
  toast(message: string): void;
  toastWhy(e: unknown, said: string): void;
}

// each listener draws from its own snapshot, so telling them all renders only the one that moved
const heard = new Set<() => void>();
export const watchSources = (fn: () => void) => { heard.add(fn); return () => { heard.delete(fn); }; };
export const tellSources = () => { for (const fn of [...heard]) fn(); };

let capture: CaptureState | null = null;
export type SetCapture = (next: CaptureState | null | ((c: CaptureState) => CaptureState)) => void;
function setCapture(next: CaptureState | null | ((c: CaptureState) => CaptureState)): void {
  capture = typeof next === "function" ? (capture ? next(capture) : null) : next;
  if (capture && !captureChunk) loadCapture().catch(() => {});
  tellSources();
}
const captureNow = () => capture;

let hooks: Hooks | null = null;
let fileInput: HTMLInputElement | null = null;
let pickFor: Target = null;
let pickStudy = true;

export const captureOpen = (): boolean => !!capture;

type CaptureChunk = typeof import("./Capture.tsx");
let captureChunk: CaptureChunk | null = null;
let captureLoading: Promise<CaptureChunk> | null = null;
export function loadCapture(): Promise<CaptureChunk> {
  captureLoading ??= import("./Capture.tsx").then((m) => {
    m.bind({ React, createPortal, api: StrataAPI, resolve, set: setCapture, now: captureNow,
      added: () => store.invalidate([REGISTER, BOARDS]), landed: (r, message) => hooks?.landed(r, message) });
    captureChunk = m;
    if (capture) setCapture((c) => ({ ...c }));           // a dialog asked for before it came: draw it
    return m;
  }, (e) => {
    captureLoading = null;                               // a failed fetch may be retried
    if (capture) { setCapture(null); hooks?.toastWhy(e, "couldn't open the link dialog"); }
    throw e;
  });
  return captureLoading;
}
export const closeCapture = (): void => setCapture(null);

async function resolve(board: Target): Promise<string | null> {
  if (board === UNFILED) return sources.unfiled();
  return board ?? hooks?.current() ?? null;
}

export const addSource = {
  file(board: Target, study = true): void { pickFor = board; pickStudy = study; fileInput?.click(); },
  link(board: Target): void { setCapture({ boardId: board, step: "url", url: "", vtt: "", busy: false, error: "", dialog: {} }); },
  async files(list: FileList | File[] | null | undefined, board: Target, study = true): Promise<void> {
    const chosen = Array.from(list || []);
    if (!chosen.length) return;
    try {
      const id = await resolve(board);
      if (id) await addImports(chosen, id, study);
    } catch (e) { hooks?.toastWhy(e, "couldn't queue files"); }
  },
  saveLink: async (board: Target, url: string): Promise<"added" | "captions"> => (await loadCapture()).saveLink(board, url.trim()),
};

export function AddSourceHost(props: Hooks) {
  hooks = props;
  const cap = useSyncExternalStore(watchSources, captureNow, captureNow);
  return <>
    <input ref={(el) => { fileInput = el; }} aria-label="Add source files" type="file" accept=".pdf,.md,.txt,.html,.htm" multiple style={{ display: "none" }}
      onChange={(e) => { const target = pickFor, study = pickStudy; pickFor = null; pickStudy = true; void addSource.files(e.target.files, target, study); e.target.value = ""; }} />
    {cap && captureChunk ? <captureChunk.default cap={cap} onClose={closeCapture} toast={props.toast} /> : null}
  </>;
}

export interface Receipt { board: string; resource: string; label: string }
let receipt: Receipt | null = null;
const receiptNow = () => receipt;
export function showReceipt(r: Receipt | null): void { receipt = r; tellSources(); }
export function ImportReceipt({ onOpen }: { onOpen(board: string, resource: string): void }) {
  const r = useSyncExternalStore(watchSources, receiptNow, receiptNow);
  return r ? <div className="import-receipt" role="status"><span>Added {r.label}</span>
    <button onClick={() => { showReceipt(null); onOpen(r.board, r.resource); }}>Open</button>
    <button aria-label="Dismiss import receipt" onClick={() => showReceipt(null)}>✕</button></div> : null;
}

export function AddSourceForm({ board = UNFILED }: { board?: Target }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [study, setStudy] = useState(true);
  const linkEl = useRef<HTMLInputElement>(null);
  async function submit() {
    const url = link.trim();
    if (!url || busy) return;
    setBusy(true); setErr("");
    try { await addSource.saveLink(board, url); setLink(""); }
    catch (e) { setErr(StrataWhy(e, "couldn't take that link")); }
    setBusy(false);
  }
  return <>
    <form className="rg-take" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input ref={linkEl} className="rg-paste" aria-label="Link to save" value={link} disabled={busy}
        placeholder="Paste a link to save for later…" onChange={(e) => setLink(e.target.value)}
        onFocus={() => void loadCapture().catch(() => {})} />
      <button className="rg-take-b home-save" disabled={busy || !link.trim()}>{busy ? "Saving…" : "Save link"}</button>
      <span className="home-capture-divider" aria-hidden="true" />
      <button type="button" className="home-quiet" onClick={() => addSource.file(board, study)}>+ Add file</button>
      <button type="button" className="home-quiet" aria-pressed={study} title="Make flashcards from the file as it arrives; you can always make them later"
        onClick={() => setStudy((v) => !v)}>flashcards: {study ? "on" : "off"}</button>
    </form>
    {err ? <div className="rg-err" role="alert">{err}</div> : null}
  </>;
}
