// snapshot(page, size) and snapshotPart(page, selector): self-contained HTML Figma's importer turns into editable layers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../race/serve.mjs";

/** Computed styles inlined per element, canvases and iframes as images, latin fonts embedded; no script, no stylesheet. */
export async function snapshot(page, { width, height }) {
  const { html, fonts } = await capture(page, { width, height, part: null });
  return `<!doctype html>${html.replace(/<head>[\s\S]*?<\/head>/, `<head><meta charset="utf-8"><style>${fonts}</style></head>`)}`;
}

/** One element, styled as it is drawn, for the Foundations page: { html, fonts }. */
export async function snapshotPart(page, selector) {
  const { width, height } = page.viewportSize();
  return capture(page, { width, height, part: selector });
}

async function capture(page, { width, height, part }) {
  const frames = [];
  for (const f of await page.locator("iframe").all()) frames.push((await f.isVisible()) ? `data:image/png;base64,${(await f.screenshot()).toString("base64")}` : null);
  const { html, faces } = await page.evaluate(({ frames, width, height, part }) => {
    if (part) { const t = document.querySelector(part); if (!t) throw new Error(`no element matches ${part}`); t.setAttribute("data-part", ""); }
    const PROPS = ["display","position","top","right","bottom","left","z-index","box-sizing","width","height","min-width","min-height","max-width","max-height",
      "margin-top","margin-right","margin-bottom","margin-left","padding-top","padding-right","padding-bottom","padding-left",
      "border-top-width","border-right-width","border-bottom-width","border-left-width","border-top-style","border-right-style","border-bottom-style","border-left-style",
      "border-top-color","border-right-color","border-bottom-color","border-left-color","border-top-left-radius","border-top-right-radius","border-bottom-left-radius","border-bottom-right-radius",
      "flex-direction","flex-wrap","justify-content","align-items","align-content","align-self","flex-grow","flex-shrink","flex-basis","order","gap","row-gap","column-gap",
      "grid-template-columns","grid-template-rows","grid-column-start","grid-column-end","grid-row-start","grid-row-end","grid-auto-flow",
      "color","background-color","background-image","background-size","background-position","background-repeat","opacity","visibility","overflow-x","overflow-y",
      "box-shadow","transform","transform-origin","font-family","font-size","font-weight","font-style","line-height","letter-spacing","text-align","text-transform",
      "text-decoration-line","text-decoration-color","text-decoration-style","text-decoration-thickness","text-underline-offset","white-space","word-break","overflow-wrap","text-overflow","text-indent","vertical-align",
      "font-variant-numeric","font-feature-settings","list-style-type","object-fit","fill","stroke","stroke-width","filter","backdrop-filter","outline-style","outline-width","outline-color","cursor","-webkit-line-clamp","-webkit-box-orient"];
    // CSS zoom is baked into the lengths: Figma's importer lays out plain pixels
    const scaled = (v, k) => (k === 1 ? v : v.replace(/(-?\d*\.?\d+)px/g, (_, n) => `${+(n * k).toFixed(3)}px`));
    const styleOf = (cs, k = 1) => PROPS.map((p) => { const v = cs.getPropertyValue(p); return v ? `${p}:${scaled(v, k)}` : ""; }).filter(Boolean).join(";");
    const zoomOf = (el) => { let k = 1; for (let n = el; n instanceof Element; n = n.parentElement) k *= parseFloat(getComputedStyle(n).zoom) || 1; return k; };
    const orig = [document.documentElement, ...document.documentElement.querySelectorAll("*")];
    const clone = document.documentElement.cloneNode(true);
    const copy = [clone, ...clone.querySelectorAll("*")];
    const used = new Set();
    let fi = 0;
    orig.forEach((el, i) => {
      const c = copy[i];
      if (!(el instanceof Element) || ["SCRIPT","STYLE","LINK","NOSCRIPT","TEMPLATE","HEAD","META","TITLE"].includes(el.tagName)) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none") { c.setAttribute("style", "display:none"); return; }
      used.add(`${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}`);
      const k = zoomOf(el);
      // inside an svg, lengths are in the viewBox's units: keep paint, leave geometry to the attributes
      let style = el instanceof SVGElement && !(el instanceof SVGSVGElement)
        ? ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity"].map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";")
        : styleOf(cs, k);
      const r = el.getBoundingClientRect();
      if (el instanceof HTMLCanvasElement || el instanceof HTMLIFrameElement) {
        const img = document.createElement("img");
        if (el instanceof HTMLCanvasElement) { try { img.src = el.toDataURL("image/png"); } catch { } } else { const s = frames[fi++]; if (s) img.src = s; }
        img.setAttribute("style", `${style};width:${r.width}px;height:${r.height}px`);
        c.replaceWith(img); return;
      }
      // a one-line label must stay one line when Figma's copy of the font runs a hair wider
      const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (texts.length) {
        const tops = new Set();
        for (const t of texts) { const range = document.createRange(); range.selectNodeContents(t); for (const q of range.getClientRects()) tops.add(Math.round(q.top)); }
        if (tops.size === 1) style += ";white-space:nowrap";
      }
      if (el instanceof HTMLInputElement) { if (el.type === "checkbox" || el.type === "radio") { if (el.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); } else c.setAttribute("value", el.value); }
      if (el instanceof HTMLTextAreaElement) c.textContent = el.value;
      if (el.scrollTop > 0) c.setAttribute("data-scrolled", String(el.scrollTop));
      // fixed and top-layer boxes go where they were painted: the importer neither centres a dialog nor knows the viewport
      if (cs.position === "fixed" || el.matches(":modal")) style += `;position:fixed;top:${r.top}px;left:${r.left}px;right:auto;bottom:auto;margin:0px;width:${r.width}px;height:${r.height}px`;
      c.setAttribute("style", style);
      if (el.matches(":modal")) {
        const veil = getComputedStyle(el, "::backdrop").backgroundColor;
        if (veil && veil !== "rgba(0, 0, 0, 0)") { const v = document.createElement("div"); v.setAttribute("style", `position:fixed;top:0px;left:0px;width:${innerWidth}px;height:${innerHeight}px;z-index:2147483000;background-color:${veil}`); v.setAttribute("data-top", ""); c.before(v); }
      }
      // out of the top layer, a dialog would be clipped by whatever box it was declared in
      if (el instanceof HTMLDialogElement && el.open) { c.setAttribute("data-top", ""); c.style.zIndex = "2147483001"; }
      c.removeAttribute("class");
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (!ps.content || ps.content === "none" || ps.content === "normal" || ps.display === "none") continue;
        const span = document.createElement("span");
        const m = /^"(.*)"$/s.exec(ps.content);
        span.textContent = m ? m[1].replace(/\\"/g, '"') : "";
        span.setAttribute("style", styleOf(ps, k));
        if (pseudo === "::before") c.insertBefore(span, c.firstChild); else c.appendChild(span);
      }
    });
    clone.querySelectorAll("script,noscript,link,style,template").forEach((n) => n.remove());
    const body0 = clone.querySelector("body");
    for (const t of clone.querySelectorAll("[data-top]")) { t.removeAttribute("data-top"); body0?.appendChild(t); }
    for (const d of clone.querySelectorAll("dialog")) {
      const div = document.createElement("div");
      for (const a of d.attributes) if (a.name !== "open") div.setAttribute(a.name, a.value);
      div.append(...d.childNodes); d.replaceWith(div);
    }
    clone.querySelectorAll("[data-scrolled]").forEach((n) => { const k = n.firstElementChild; if (k) k.style.marginTop = `calc(${k.style.marginTop || "0px"} - ${n.getAttribute("data-scrolled")}px)`; n.removeAttribute("data-scrolled"); });
    clone.style.width = `${width}px`;
    if (height) { clone.style.height = `${height}px`; clone.style.overflow = "hidden"; } else clone.style.height = `${document.documentElement.scrollHeight}px`;
    const body = clone.querySelector("body"); if (body) { body.style.width = `${width}px`; body.style.margin = "0"; }
    const faces = [];
    for (const sheet of document.styleSheets) { try { for (const r of sheet.cssRules) if (r instanceof CSSFontFaceRule) faces.push(r.cssText); } catch { } }
    const picked = part && clone.querySelector("[data-part]");
    if (picked) { picked.removeAttribute("data-part"); Object.assign(picked.style, { position: "relative", top: "auto", left: "auto", right: "auto", bottom: "auto", margin: "0px" }); }
    document.querySelector("[data-part]")?.removeAttribute("data-part");
    return { html: picked ? picked.outerHTML : clone.outerHTML, faces: faces.join("\n") };
  }, { frames, width, height, part });
  const fonts = faces.replace(/@font-face\s*{[^}]*}/g, (block) => {
    if (/unicode-range/.test(block) && !/unicode-range:[^;]*U\+0-FF\b/i.test(block)) return "";
    return block.replace(/url\("?([^)"]+\.woff2)"?\)/g, (_, u) => {
      const f = join(REPO, "dist", u.split("/").pop());
      return existsSync(f) ? `url(data:font/woff2;base64,${readFileSync(f).toString("base64")})` : `url(${u})`;
    });
  });
  return { html, fonts };
}
