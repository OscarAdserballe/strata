// The writes that waited offline and met a newer text: each shown as this device's and the other, settled one at a time.
import { useState } from "react";
import { StrataPath, StrataWhy } from "../../data/api.ts";
import { dash } from "../../data/entities/dashboard.ts";
import { outbox, type Clash } from "../../data/outbox.ts";

const QUOTE_MAX = 8000;
const cutAt = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const placeOf = (c: Clash) => [c.where.title ?? "this board", c.where.source ?? "board notes",
  c.where.passage ? `“${cutAt(c.where.passage, 90)}”` : null].filter(Boolean).join(" · ");
const linkOf = (c: Clash) => {
  const q = new URLSearchParams({ board: c.where.board, ...(c.where.source ? { resource: c.where.source } : {}) });
  return `${location.origin}${StrataPath(`/?${q}`)}`;
};

/** An inbox item quoting both texts, so an agent can merge them with the passage one click away. */
export function handOff(c: Clash) {
  const cut = (t: string) => (t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}…` : t);
  return {
    title: `Merge two versions of ${placeOf(c)}`.slice(0, 300),
    context: "Written offline on one device while the other text was saved elsewhere.",
    body: `This device wrote:\n\n${cut(c.mine)}\n\n---\n\nThe other text, saved at revision ${c.rev}:\n\n${cut(c.theirs)}`,
    from: { source: "Strata offline sync", url: linkOf(c) },
    links: [{ kind: "strata", ref: c.where.board, title: placeOf(c).slice(0, 300), url: linkOf(c) }],
  };
}

function ClashRow({ clash }: { clash: Clash }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = (fn: () => Promise<unknown>, said: string) => async () => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(StrataWhy(e, said)); setBusy(false); }
  };
  return <li className="clash" data-clash={clash.id}>
    <p className="clash-where">{placeOf(clash)}</p>
    <div className="clash-texts">
      <figure><figcaption>this device</figcaption><pre>{clash.mine || "(empty)"}</pre></figure>
      <figure><figcaption>the other text</figcaption><pre>{clash.theirs || "(empty)"}</pre></figure>
    </div>
    <div className="clash-actions">
      <button disabled={busy} onClick={act(() => outbox.resolve(clash.id, "mine"), "yours didn't save")}>Keep mine</button>
      <button disabled={busy} onClick={act(() => outbox.resolve(clash.id, "theirs"), "couldn't drop yours")}>Keep theirs</button>
      <button disabled={busy} onClick={act(async () => { await dash.file(handOff(clash)); await outbox.resolve(clash.id, "theirs"); }, "couldn't hand that over")}>Hand to an agent</button>
    </div>
    {error ? <p className="clash-error" role="alert">{error}</p> : null}
  </li>;
}

export default function ClashList({ clashes, onClose }: { clashes: readonly Clash[]; onClose: () => void }) {
  return <section className="clash-list" aria-label="Clashes">
    <header><strong>{`${clashes.length} clash${clashes.length === 1 ? "" : "es"}`} · written here while offline, saved differently elsewhere</strong>
      <button onClick={onClose} aria-label="Close clashes">Close</button></header>
    <ul>{clashes.map((c) => <ClashRow key={c.id} clash={c} />)}</ul>
  </section>;
}
