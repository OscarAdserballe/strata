import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";
import { StrataAPI } from "../../data/api.ts";
import { facesOf } from "../../../shared/cards/faces.ts";
import { Preview } from "./CardForm.tsx";
import { createCardTidier } from "./tidy.ts";
import { useFaceImages } from "../attach/useFaceImages.ts";
import { FaceStrip } from "../attach/Tray.tsx";

export type ComposedCard = { [face: string]: CardFaces[string] | undefined; source?: string };

export interface ComposerProps {
  front0?: string;
  answer?: string;
  anchor?: string | null;
  closing?: boolean;
  review?: boolean;
  onSave: (card: ComposedCard) => unknown;
  onCancel: () => void;
}

const failed = (e: unknown, said: string) => (e as { message?: string } | null)?.message || said;

export default function Composer({ front0, anchor, closing, review, onSave, onCancel }: ComposerProps) {
  const [front, setFront] = useState(front0 || "");
  const [back, setBack] = useState("");
  const [source, setSource] = useState("");
  // a slow save got pressed repeatedly and made duplicate cards; refuse presses while busy
  const [busy, setBusy] = useState<false | "tidying" | "saving">(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ComposedCard | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const saveBusy = useRef(false);
  const tidier = useRef(createCardTidier(StrataAPI.tidyCard));
  async function format() {
    if (saveBusy.current) return;
    saveBusy.current = true; setBusy("tidying"); setError("");
    try {
      const faces = await tidier.current("flashcard", { front: front.trim(), back: back.trim() });
      setPreview({ ...faces, source: source.trim() || undefined });
    } catch (e) { setError(failed(e, "Couldn't format this card. Your draft is still here.")); }
    finally { saveBusy.current = false; setBusy(false); }
  }
  function backToEditing() {
    if (saveBusy.current || !preview) return;
    setFront(String(preview.front ?? "")); setBack(String(preview.back ?? "")); setSource(preview.source || "");
    setPreview(null); setError("");
  }
  async function save() {
    if (!preview || saveBusy.current) return;
    saveBusy.current = true; setBusy("saving"); setError("");
    try {
      await onSave(preview);
    } catch (e) { setError(failed(e, "Couldn't save this card. Your draft is still here.")); }
    finally { saveBusy.current = false; setBusy(false); }
  }
  const frontPics = useFaceImages(front, setFront);
  const backPics = useFaceImages(back, setBack);
  const backRef = useRef<HTMLTextAreaElement>(null);
  const frontRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { (preview ? previewRef : front0 ? backRef : frontRef).current?.focus(); }, [preview]);
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!saveBusy.current) { if (preview) backToEditing(); else onCancel(); } } };
  return (
    <div className="comp" onKeyDown={esc}>
      <div className="comp-head">{closing ? "close the card" : "new card"}
        <span className="comp-where">→ your cards{anchor ? " · " + anchor : ""}</span></div>
      {preview ? <div ref={previewRef} tabIndex={-1} role="region" aria-label="Formatted card preview">
        <Preview fields={facesOf("flashcard")} draft={preview} label="Formatted preview" />
        {preview.source ? <p className="comp-lbl">Source: {preview.source}</p> : null}
      </div> : <>
      <div className="comp-lbl">the front — the question you asked; rephrase it</div>
      <textarea disabled={!!busy} ref={frontRef} className="comp-ta front" value={front} onChange={(e) => setFront(e.target.value)} onKeyDown={esc} {...frontPics.handlers} />
      <FaceStrip refs={frontPics.refs} onRemove={frontPics.remove} />
      {frontPics.status ? <span className="att-status" role="status">{frontPics.status}</span> : null}
      <div className="comp-lbl">the back — yours to write{review ? "" : "; the chat stays open below"}</div>
      <textarea disabled={!!busy} ref={backRef} className="comp-ta back" value={back} onChange={(e) => setBack(e.target.value)} onKeyDown={esc}
        placeholder={closing ? "from the front alone, if you can…" : review ? "the answer you want to remember…" : "talk it out in the thread, then say it in your own words…"} {...backPics.handlers} />
      <FaceStrip refs={backPics.refs} onRemove={backPics.remove} />
      {backPics.status ? <span className="att-status" role="status">{backPics.status}</span> : null}
      <label className="comp-lbl" htmlFor="card-source-location">Source location (optional)</label>
      <input disabled={!!busy} id="card-source-location" className="comp-ta" value={source} onChange={e => setSource(e.target.value)} onKeyDown={esc}
        placeholder='p. 12, #heading, @1:20, or "exact words from the source"' />
      <p className="comp-lbl">Pasted source text is matched automatically. Otherwise, the place you’re reading is kept.</p>
      </>}
      <p className="comp-lbl">{preview ? "Review before saving." : "Format your card, then review it before saving."}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="comp-row">
        {preview ? <button className="mint-ghost" disabled={!!busy} onClick={backToEditing}>Back to editing</button> : null}
        <button className="mint-go" disabled={!!busy || !front.trim() || !back.trim()}
          onClick={preview ? save : format}>{busy === "tidying" ? "Formatting…" : busy ? "Saving…" : preview ? "Confirm save" : "Format & Preview"}</button>
        <button className="mint-ghost" disabled={!!busy} onClick={onCancel}>esc</button>
      </div>
    </div>
  );
}
