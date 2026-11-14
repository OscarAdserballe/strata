import { STRATA, type Box, type FromPage, type LiveMark, type ToPage } from "./protocol.ts";
import type { LayerIntents, LayerItem } from "../fold/layers.ts";

export interface HtmlHooks {
  /** a selection of words, or a labelled box picked whole (`box` names it) */
  onSelect(sel: { start: number; end: number; quote: string; box?: string | null; own?: string | null } | null, at: Box | null): void;
  onMark(id: string): void;
  onPress(): void;
  /** The saved state (JSON text) of the page opened at `url`, or null if it has none; rejects when it can't be read. */
  onLoad(url: string): Promise<string | null>;
  onSave(url: string, value: string): Promise<void>;
}

// Owns one sandboxed iframe and the conversation with the bridge inside it; knows nothing of the room.
export class HtmlEngine {
  private frame: HTMLIFrameElement | null = null;
  private url = "";
  private ready = false;
  private queued: ToPage[] = [];
  private asks = new Map<number, (found: boolean) => void>();
  private n = 0;
  private hooks: HtmlHooks;
  private layerOn: LayerIntents | null = null;
  /** the last paint of each kind, which a frame that replaces this one must also get */
  private drawn: { marks?: ToPage; layers?: ToPage } = {};

  constructor(hooks: HtmlHooks) {
    this.hooks = hooks;
    addEventListener("message", this.hear);
  }

  open(host: HTMLElement, url: string): void {
    if (this.frame && this.frame.isConnected && this.frame.parentElement === host && this.url === url) return;
    // what was asked before the frame existed still goes to it once it is ready; so does a paint the reader
    // sent for this page while the frame it replaces was still up, since that one is about to go
    const asked = this.queued;
    const drawn = Object.values(this.drawn).filter((m) => !asked.some((a) => a.t === m.t));
    this.close();
    this.queued = [...asked, ...drawn];
    const f = document.createElement("iframe");
    // no allow-same-origin: with it, the page could lift its own sandbox
    f.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms");
    f.setAttribute("allow", "fullscreen");
    f.setAttribute("title", "live page");
    f.className = "html-frame";
    f.src = url;
    host.appendChild(f);
    this.frame = f; this.url = url;
  }

  close(): void {
    this.frame?.remove();
    this.frame = null; this.url = ""; this.ready = false; this.queued = [];
    for (const done of this.asks.values()) done(false);
    this.asks.clear();
  }

  dispose(): void { this.close(); removeEventListener("message", this.hear); }

  paint(marks: LiveMark[], open: string | null): void {
    // only the latest paint matters, so a queue before ready keeps one
    this.queued = this.queued.filter((m) => m.t !== "marks");
    this.post(this.drawn.marks = { t: "marks", marks, open });
  }

  /** the page draws these layers itself; what the reader does in them comes back through `on` */
  layers(items: readonly LayerItem[], on: LayerIntents, scale: number, fresh = false): void {
    this.layerOn = on;
    this.queued = this.queued.filter((m) => m.t !== "layers");
    this.post(this.drawn.layers = { t: "layers", items: [...items], scale, fresh });
  }

  reveal(quote: string | null, slug: string | null, box: string | null = null): Promise<boolean> {
    if (!this.frame) return Promise.resolve(false);
    const n = ++this.n;
    return new Promise((resolve) => {
      this.asks.set(n, resolve);
      this.post({ t: "reveal", n, quote, slug, box });
      setTimeout(() => { if (this.asks.delete(n)) resolve(false); }, 4000);
    });
  }

  clearSelection(): void { this.post({ t: "clear" }); }
  focus(): void { this.frame?.focus(); }

  private post(m: ToPage): void {
    if (!this.ready || !this.frame?.contentWindow) { this.queued.push(m); return; }
    this.frame.contentWindow.postMessage({ [STRATA]: m }, "*");
  }

  // only to the frame that asked: a page swapped out meanwhile hears nothing
  private answer(asked: HTMLIFrameElement, reply: Promise<ToPage>): void {
    void reply.then((m) => { if (this.frame === asked) asked.contentWindow?.postMessage({ [STRATA]: m }, "*"); });
  }

  // the frame's origin is opaque ("null"), so the sender is checked by window, never by origin
  private hear = (e: MessageEvent): void => {
    const f = this.frame;
    if (!f || e.source !== f.contentWindow) return;
    const m = (e.data || {})[STRATA] as FromPage | undefined;
    if (!m) return;
    const at = (b: Box): Box => { const r = f.getBoundingClientRect(); return { ...b, left: b.left + r.left, top: b.top + r.top }; };
    switch (m.t) {
      case "ready": { this.ready = true; const q = this.queued; this.queued = []; q.forEach((x) => this.post(x)); break; }
      case "sel": this.hooks.onSelect({ start: m.start, end: m.end, quote: m.quote, box: m.at ?? null, own: m.own }, at(m.box)); break;
      case "unsel": this.hooks.onSelect(null, null); break;
      case "mark": this.hooks.onMark(m.id); break;
      case "layer": {
        const on = this.layerOn;
        if (!on) break;
        if (m.intent === "edit" || m.intent === "remove" || m.intent === "show" || m.intent === "later" || m.intent === "discard") on[m.intent](m.id);
        else if (m.intent === "keep") on.keep(m.id, String(m.text ?? ""), String(m.back ?? ""));
        else if (m.intent === "grade") on.grade(m.id, !!m.got);
        else if (m.intent === "capture") on.capture(m.id, Number(m.text));
        else on[m.intent](m.id, String(m.text ?? ""));
        break;
      }
      case "revealed": { const done = this.asks.get(m.n); this.asks.delete(m.n); done?.(m.found); break; }
      case "press": this.hooks.onPress(); break;
      case "load": this.answer(f, this.hooks.onLoad(this.url).then((value) => ({ t: "state", n: m.n, value }) as ToPage,
        (e: unknown) => ({ t: "state", n: m.n, value: null, why: reason(e) }))); break;
      case "save": this.answer(f, this.hooks.onSave(this.url, m.value).then(() => ({ t: "saved", n: m.n, ok: true }) as ToPage,
        (e: unknown) => ({ t: "saved", n: m.n, ok: false, why: reason(e) }))); break;
    }
  };
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? "it couldn't be saved")).slice(0, 300);
