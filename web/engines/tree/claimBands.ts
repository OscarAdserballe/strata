import { anchorOf } from "../../../shared/reading/anchors.ts";
import { pageTop } from "../pdf/landing.ts";
import { anchorEl, quotesOnce } from "../position/anchors-dom.ts";
import type { Claim } from "./claims.ts";

// Bands are hand-written DOM (React would fight pdf.js and the split text nodes) and must not move the page.

export interface BandCard { id: string; node?: string | null }

// Kept separate from band building: the card changes on every drill keypress and rebuilds move the scroll.
export function litClaims(host: ParentNode | null, node: string | null): void {
  if (!host) return;
  for (const row of host.querySelectorAll<HTMLElement>(".clm-row")) {
    row.classList.toggle("here", !!node && row.dataset.node === node);
  }
}

export function paintClaims(host: HTMLElement | null, kind: string | null, claims: Claim[],
  cards: readonly BandCard[] | null | undefined, go: (cardId: string) => void, lit: string | null): void {
  if (!host) return;
  const col = kind ? host.querySelector<HTMLElement>(kind === "pdf" ? ".pdf-col" : ".prose") : null;

  // Only this pair's cards, so a band in another chapter shows no count rather than a wrong one.
  const byNode = new Map<string, BandCard[]>();
  for (const c of cards || []) {
    if (!c.node) continue;
    if (!byNode.has(c.node)) byNode.set(c.node, []);
    byNode.get(c.node)!.push(c);
  }
  // Skip the rebuild when nothing changed; rebuilding inserts height and has to restore the scroll.
  const sig = claims.map((n) => n.id + "@" + n.anchor + "×" + (byNode.get(n.id) || []).length).join("|");
  if (col && col.dataset.clm === sig && (!claims.length || host.querySelector(".clm"))) { litClaims(host, lit); return; }

  let hold: { el: HTMLElement; into: number } | null = null;
  for (const b of host.querySelectorAll<HTMLElement>(kind === "pdf" ? ".slide" : ".prose [data-b]")) {
    if (b.offsetTop <= host.scrollTop + 4) hold = { el: b, into: host.scrollTop - b.offsetTop };
    else break;
  }
  host.querySelectorAll(".clm").forEach((c) => c.remove());
  const put = () => {
    if (col) col.dataset.clm = sig;
    if (!hold || !hold.el.isConnected) return;
    // Restore to the page's opening claim, not the page, or the band arriving late hides that line.
    host.scrollTop = hold.into <= 0 && hold.el.classList.contains("slide")
      ? pageTop(hold.el)
      : Math.max(0, hold.el.offsetTop + hold.into);
  };
  if (!claims.length || !kind) { put(); return; }

  const groups = new Map<Element, Claim[]>();
  const quotes = quotesOnce(host, kind);
  for (const n of claims) {
    if (!n.anchor) continue;
    const el = anchorEl(host, kind, anchorOf({ source: n.anchor }), quotes);
    if (!el) continue;
    if (!groups.has(el)) groups.set(el, []);
    groups.get(el)!.push(n);
  }
  for (const [el, list] of groups) {
    if (!el.parentNode) continue;
    const band = document.createElement("div");
    band.className = "clm";
    for (const n of list) {
      const mine = byNode.get(n.id) || [];
      const d = Math.min(n.depth, 4);
      const row = document.createElement("div");
      row.className = "clm-row d" + d + (mine.length ? " clmgo" : "");
      row.style.setProperty("--d", String(d));
      row.dataset.node = n.id;
      if (n.questions.length) row.title = n.questions.join("\n");
      const num = document.createElement("span");
      num.className = "clm-n"; num.textContent = String(n.id || "").replace(/^n/, "");
      const lab = document.createElement("span");
      lab.className = "clm-l"; lab.textContent = n.label || "";
      row.append(num, lab);
      if (mine.length) {
        const c = document.createElement("span");
        c.className = "clm-c"; c.textContent = mine.length + " ×";
        row.appendChild(c);
        row.onclick = () => go(mine[0].id);
        row.title = (row.title ? row.title + "\n\n" : "")
          + mine.length + " card" + (mine.length > 1 ? "s" : "") + " from this claim — click to go to them";
      }
      band.appendChild(row);
    }
    el.parentNode.insertBefore(band, el);
  }
  put();
  litClaims(host, lit);
}
