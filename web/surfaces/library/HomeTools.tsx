import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { authored } from "../../data/entities/authored.ts";
import { mintKey } from "../../data/mutate.ts";
import { createCardTidier } from "../../capabilities/card/tidy.ts";
import { facesOf } from "../../../shared/cards/faces.ts";
import { Preview } from "../../capabilities/card/CardForm.tsx";
import { mdBlocks } from "../../engines/prose/blocks.tsx";
import { MathText } from "../../engines/prose/math.tsx";
import { useFaceImages } from "../../capabilities/attach/useFaceImages.ts";
import { FaceStrip } from "../../capabilities/attach/Tray.tsx";
import ConnectAgent from "./ConnectAgent.tsx";
import "./home-tools.css";

type Library = Awaited<ReturnType<typeof StrataAPI.library>>;
type Draft = { front: string; back: string; source: string; requestId: string };
// getRandomValues, not randomUUID, which isn't available over plain http
const draft = (front = "", back = ""): Draft => ({ front, back, source: "", requestId: mintKey() });
export type Compose = (front: string, back: string) => void;

export default function HomeTools({ onCardsChanged, composeRef }: { onCardsChanged?: () => void; composeRef?: React.MutableRefObject<Compose | null> }) {
  const [mode, setMode] = useState<"card" | "cards" | null>(null);
  const [library, setLibrary] = useState<Library>({ messages: [], cards: [], before: null });
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [card, setCard] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Draft | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const live = useRef(true);
  const saveBusy = useRef(false);
  const tidier = useRef(createCardTidier(StrataAPI.tidyCard));
  const [tidying, setTidying] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    if (!composeRef) return;
    composeRef.current = (front, back) => { setCard(draft(front, back)); setPreview(null); setMode("card"); setError(""); setNotice(""); };
    return () => { composeRef.current = null; };
  }, [composeRef]);
  useEffect(() => {
    if (mode) { if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [mode]);
  useEffect(() => { if (mode === "card") previewRef.current?.focus(); }, [preview, mode]);
  useEffect(() => {
    if (mode !== "cards" || loaded) return;
    let current = true;
    StrataAPI.library().then(data => { if (current) { setLibrary(data); setLoaded(true); } })
      .catch(e => { if (current) setError(StrataWhy(e, "Couldn't load your library")); });
    return () => { current = false; };
  }, [mode, loaded, reload]);

  function open(next: "card" | "cards") {
    setError(""); setNotice(""); setMode(next);
    if (next === "card" && !card) { setCard(draft()); setPreview(null); }
  }
  const frontPics = useFaceImages(card?.front ?? "", (front) => setCard((c) => (c ? { ...c, front } : c)));
  const backPics = useFaceImages(card?.back ?? "", (back) => setCard((c) => (c ? { ...c, back } : c)));
  async function format(e: React.FormEvent) {
    e.preventDefault();
    if (!card || saveBusy.current) return;
    saveBusy.current = true; setSaving(true); setTidying(true); setError("");
    try {
      const faces = await tidier.current("flashcard", { front: card.front.trim(), back: card.back.trim() });
      if (live.current && cardRef.current?.requestId === card.requestId) {
        setPreview({ ...card, front: String(faces.front), back: String(faces.back) });
      }
    } catch (e) {
      if (live.current && cardRef.current?.requestId === card.requestId) setError(StrataWhy(e, "Couldn't format this card"));
    } finally { saveBusy.current = false; if (live.current) { setSaving(false); setTidying(false); } }
  }
  function backToEditing() {
    if (!preview || saveBusy.current) return;
    setCard(preview); setPreview(null); setError("");
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || preview.requestId !== card?.requestId || saveBusy.current) return;
    const saved = preview;
    saveBusy.current = true; setSaving(true); setError("");
    try {
      const result = await authored.personal(saved);
      if (!live.current) return;
      setLibrary(was => ({ ...was, cards: [{ ...saved, id: result.id }, ...was.cards.filter(c => c.id !== result.id)] }));
      const sameDraft = cardRef.current?.requestId === saved.requestId;
      setCard(current => current?.requestId === saved.requestId ? null : current);
      setPreview(current => current?.requestId === saved.requestId ? null : current);
      if (sameDraft) setMode(current => current === "card" ? "cards" : current);
      setNotice("Saved to Unfiled and kept for review.");
      onCardsChanged?.();
    } catch (e) { if (live.current) setError(StrataWhy(e, "Couldn't save this card")); }
    finally { saveBusy.current = false; if (live.current) { setSaving(false); setTidying(false); } }
  }
  return <div className="home-tools">
    <button className="home-primary" onClick={() => open("card")}>New card</button>
    <button className="home-quiet" onClick={() => open("cards")}>Unfiled cards</button>
    <ConnectAgent />
    {createPortal(<dialog className="home-tool-dialog" ref={dialog} aria-labelledby="home-tool-title"
      onCancel={e => {
        if (mode === "card" && preview && !saveBusy.current) { e.preventDefault(); backToEditing(); }
        else setMode(null);
      }} onKeyDown={e => e.stopPropagation()}>
      <header><h2 id="home-tool-title">{mode === "card" ? "New card" : "Unfiled cards"}</h2>
        <button aria-label="Close" onClick={() => setMode(null)}>✕</button></header>
      <nav aria-label="Library tools">
        <button aria-pressed={mode === "card"} onClick={() => open("card")}>New card</button>
        <button aria-pressed={mode === "cards"} onClick={() => open("cards")}>Unfiled cards</button>
      </nav>
      {error ? <p role="alert">{error}{mode === "cards" && !loaded ? <button onClick={() => { setError(""); setReload(n => n + 1); }}>Retry loading</button> : null}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {mode === "card" && card ? <form className="home-tool-form" onSubmit={preview ? save : format}>
        <p className="home-tool-note">{preview ? "Review the formatted card, then confirm to save it to Unfiled and keep it for review." : "Format your card, then review it before saving. The words stay yours."}</p>
        {preview ? <div ref={previewRef} tabIndex={-1} role="region" aria-label="Formatted card preview">
          <Preview fields={facesOf("flashcard")} draft={preview} label="Formatted preview" />
          {preview.source ? <p className="home-tool-note">Source: {preview.source}</p> : null}
        </div> : <>
        <label htmlFor="personal-front">Front</label>
        <textarea id="personal-front" autoFocus required value={card.front} disabled={saving} onChange={e => setCard({ ...card, front: e.target.value })} {...frontPics.handlers} />
        <FaceStrip refs={frontPics.refs} onRemove={frontPics.remove} />
        {frontPics.status ? <span className="att-status" role="status">{frontPics.status}</span> : null}
        <label htmlFor="personal-back">Back</label>
        <textarea id="personal-back" required value={card.back} disabled={saving} onChange={e => setCard({ ...card, back: e.target.value })} {...backPics.handlers} />
        <FaceStrip refs={backPics.refs} onRemove={backPics.remove} />
        {backPics.status ? <span className="att-status" role="status">{backPics.status}</span> : null}
        <label htmlFor="personal-source">Source or attribution (optional)</label>
        <input id="personal-source" value={card.source} disabled={saving} onChange={e => setCard({ ...card, source: e.target.value })} />
        </>}
        <div className="home-card-actions">
          {preview ? <button type="button" disabled={saving} onClick={backToEditing}>Back to editing</button> : null}
          <button type="submit" disabled={saving || !card.front.trim() || !card.back.trim()}>{tidying ? "Formatting…" : saving ? "Saving…" : preview ? "Confirm save" : "Format & Preview"}</button>
        </div>
      </form> : mode === "cards" ? <div className="home-personal-cards">
        {!loaded ? <p>Loading your cards…</p> : !library.cards.length ? <p>Your quotes, questions and ideas can live here. Create your first flashcard above.</p> : null}
        {library.cards.map(c => <details key={c.id}><summary><MathText text={c.front} /></summary>{mdBlocks(c.back)}{c.source ? <p className="home-tool-note">{c.source}</p> : null}</details>)}
      </div> : null}
    </dialog>, document.body)}
  </div>;
}
