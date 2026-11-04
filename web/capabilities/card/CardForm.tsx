import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, MutableRefObject } from "react";
import { facesOf, type Face } from "../../../shared/cards/faces.ts";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";
import { mdBlocks } from "../../engines/prose/blocks.tsx";
import { MathText } from "../../engines/prose/math.tsx";
import { tex } from "../../engines/prose/text.ts";
import { createCardTidier } from "./tidy.ts";
import type { FaceCard } from "./CardFace.tsx";
import { StrataAPI } from "../../data/api.ts";
import { useFaceImages } from "../attach/useFaceImages.ts";
import { FaceStrip } from "../attach/Tray.tsx";

export function EditButton({ onClick, edited }: { onClick: (e: MouseEvent<HTMLButtonElement>) => void; edited: boolean }) {
  return <button type="button" className={"ced-b" + (edited ? " on" : "")}
    title={edited ? "you rewrote this card — rewrite it again (e)" : "rewrite this card in your own words (e)"}
    onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{edited ? "edited" : "edit"}</button>;
}

type TextRef = MutableRefObject<HTMLTextAreaElement | null>;

interface GrowProps { value: string; rows: number; taRef: TextRef | null; onChange: (v: string) => void; disabled: boolean }

function Grow({ value, rows, taRef, onChange, disabled, images = false }: GrowProps & { images?: boolean }) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fit = (el: HTMLTextAreaElement | null) => { if (!el) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
  useEffect(() => { fit(own.current); }, [value]);
  const pics = useFaceImages(value, onChange);
  return <>
    <textarea rows={rows} value={value} disabled={disabled}
      ref={(el) => { own.current = el; if (taRef) taRef.current = el; fit(el); }}
      {...(images ? pics.handlers : {})}
      onChange={(e) => onChange(e.target.value)} />
    {images ? <FaceStrip refs={pics.refs} onRemove={pics.remove} /> : null}
    {images && pics.status ? <span className="att-status" role="status">{pics.status}</span> : null}
  </>;
}

type FaceValue = string | string[];
export type Draft = Record<string, FaceValue>;

interface FieldProps { face: Face; value: FaceValue | undefined; onChange: (v: FaceValue) => void; taRef: TextRef | null; disabled: boolean }

function Field({ face, value, onChange, taRef, disabled }: FieldProps) {
  const isOpts = face.key === "options";
  return (
    <div className="ced-f">
      <span className="ced-l">{face.label}</span>
      {isOpts
        ? <div className="ced-opts">
            {((value as string[] | undefined) || []).map((o, i) => (
              <div key={i} className="ced-opt">
                <span className="l">{i + 1}</span>
                <Grow disabled={disabled} value={o} rows={1} taRef={i === 0 ? taRef : null}
                  onChange={(v) => onChange(((value as string[] | undefined) || []).map((x, j) => (j === i ? v : x)))} />
              </div>
            ))}
          </div>
        : <Grow disabled={disabled} images value={(value as string | undefined) || ""} rows={face.rows} taRef={taRef} onChange={onChange} />}
    </div>
  );
}

const PROSE = new Set(["back", "explanation", "solution"]);

export interface PreviewProps {
  fields: Face[];
  draft: Record<string, unknown>;
  label?: string | null;
}

export function Preview({ fields, draft, label = "as it will read" }: PreviewProps) {
  const ask = String(draft[fields[0].key] ?? "");
  return (
    <div className="ced-prev">
      {label ? <span className="ced-l">{label}</span> : null}
      <div className="ced-prevcard">
        <div className="q"><MathText text={tex(ask)} /></div>
        {fields.slice(1).map((f) => {
          const v = draft[f.key];
          if (f.key === "options")
            return (
              <div key={f.key} className="opts">
                {((v as string[] | undefined) || []).map((o, i) => (
                  <div key={i} className="opt"><span className="l">{i + 1}</span><span><MathText text={tex(o)} /></span></div>
                ))}
              </div>
            );
          if (!String(v ?? "").trim()) return null;
          if (PROSE.has(f.key)) return <div key={f.key} className="a">{mdBlocks(String(v))}</div>;
          return (
            <div key={f.key} className="blk">
              <span className="lbl">{f.label}</span>
              <div className="b"><MathText text={tex(String(v))} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface CardFormProps {
  card: FaceCard & { id: string };
  faces?: Face[];
  onSave: (patch: CardFaces) => unknown;
  onCancel: () => void;
  onDelete?: (() => unknown) | null;
}

type Busy = false | "tidying" | "saving" | "deleting";

function CardForm({ card, faces, onSave, onCancel, onDelete }: CardFormProps) {
  const fields = faces || facesOf(card.type);
  const initial = () => {
    const d: Draft = {};
    for (const f of fields) d[f.key] = f.key === "options" ? (card.options || []).map((o) => String(o)) : String(card[f.key] ?? "");
    return d;
  };
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState<Busy>(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Draft | null>(null);
  const [theirs, setTheirs] = useState<Record<string, unknown> | null>(null);
  const tidier = useRef(createCardTidier(StrataAPI.tidyCard));
  const saving = useRef(false);
  const firstRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const currentCard = useRef(card.id);
  currentCard.current = card.id;
  useEffect(() => { setDraft(initial()); setPreview(null); setError(""); setTheirs(null); }, [card.id]);
  useEffect(() => { (preview ? previewRef : firstRef).current?.focus(); }, [preview]);

  const changed = (values: Draft = draft): Draft => {
    const out: Draft = {};
    for (const f of fields) {
      const was = f.key === "options" ? (card.options || []).map((o) => String(o)) : String(card[f.key] ?? "");
      const now = values[f.key];
      if (f.key === "options" ? JSON.stringify(was) !== JSON.stringify(now) : was !== now) out[f.key] = now;
    }
    return out;
  };

  function format() {
    if (busy || saving.current) return;
    if (!String(draft[fields[0].key] ?? "").trim()) { setError("a card needs its question"); return; }
    const id = card.id;
    saving.current = true; setBusy("tidying"); setError("");
    Promise.resolve().then(() => tidier.current(card.type, draft))
      .then((formatted) => { if (currentCard.current === id) setPreview(formatted); })
      .catch((e) => { if (currentCard.current === id) setError(e.message || "Couldn't format this card. Your draft is still here."); })
      .finally(() => { saving.current = false; setBusy(false); });
  }

  function backToEditing() {
    if (busy || saving.current) return;
    setDraft(preview!); setPreview(null); setError("");
  }

  function save() {
    if (!preview || busy || saving.current) return;
    const patch = changed(preview);
    if (!Object.keys(patch).length) { onCancel(); return; }
    saving.current = true; setBusy("saving"); setError(""); setTheirs(null);
    Promise.resolve().then(() => onSave(patch))
      .then(() => { saving.current = false; setBusy(false); })
      .catch((e) => {
        saving.current = false; setBusy(false);
        if (e && e.theirs) setTheirs(e.theirs);
        setError(e && e.message ? e.message : "couldn’t save that");
      });
  }

  function remove() {
    if (busy || saving.current) return;
    setBusy("deleting"); setError("");
    Promise.resolve().then(() => onDelete!())
      .then(() => setBusy(false))
      .catch((e) => { setBusy(false); setError(e && e.message ? e.message : "couldn’t delete that"); });
  }

  // the editor owns the keyboard: hosts behind it grade and reveal on bare keys
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); if (busy === "saving") onCancel(); else if (!busy) { if (preview) backToEditing(); else onCancel(); } return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!preview && !e.repeat) format(); }
  };

  return (
    <div className="ced" onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()}>
      {theirs ? <div className="ced-theirs" role="region" aria-label="The card as it is now saved">
        <Preview fields={fields} draft={theirs} label="Saved meanwhile, elsewhere" />
      </div> : null}
      {preview ? <div ref={previewRef} tabIndex={-1} role="region" aria-label="Formatted card preview">
        <Preview fields={fields} draft={preview} label={theirs ? "Yours" : "Formatted preview"} />
      </div> : fields.map((f, i) => (
        <Field disabled={!!busy} key={f.key} face={f} value={draft[f.key]} taRef={i === 0 ? firstRef : null}
          onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
      ))}
      <div className="ced-row">
        {error ? <span className="ced-err" role="alert">{error}</span> : <span className="ced-hint">{preview ? "Review before saving" : "⌘↵ format & preview · esc leave"}</span>}
        <span className="grow" />
        {onDelete && !preview ? <button type="button" className="ced-x ced-delete" disabled={!!busy}
          title="remove this card from its deck and review" onClick={remove}>{busy === "deleting" ? "deleting…" : "delete card"}</button> : null}
        {preview ? <button type="button" className="ced-x" disabled={!!busy} onClick={backToEditing}>Back to editing</button> : null}
        <button type="button" className="ced-x" disabled={!!busy && busy !== "saving"} onClick={onCancel}>{theirs ? "use theirs" : "cancel"}</button>
        <button type="button" className="ced-go" disabled={!!busy} onClick={preview ? save : format}>{busy === "tidying" ? "Formatting…" : busy === "saving" ? "Saving…" : theirs && preview ? "Keep mine" : preview ? "Confirm save" : "Format & Preview"}</button>
      </div>
    </div>
  );
}

export default CardForm;
