import "./attach.css";

let box: HTMLDialogElement | null = null;

function show(src: string, alt: string): void {
  if (!box) {
    box = document.createElement("dialog");
    box.className = "att-box";
    box.setAttribute("aria-label", "Image");
    box.appendChild(document.createElement("img"));
    box.addEventListener("click", () => box!.close());
    // esc closes the box and nothing under it: the keys of the screen beneath never hear it
    box.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); box!.close(); } });
    document.body.appendChild(box);
  }
  const img = box.firstChild as HTMLImageElement;
  img.src = src; img.alt = alt;
  if (!box.open) box.showModal();
}

let installed = false;
export function installLightbox(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // capture, so the click that opens a picture is not also the tap that turns the card over
  document.addEventListener("click", (e) => {
    const img = (e.target as Element | null)?.closest?.("img.strata-img") as HTMLImageElement | null;
    if (!img || img.closest("dialog.att-box") || img.closest("a")) return;
    e.preventDefault(); e.stopPropagation();
    show(img.currentSrc || img.src, img.alt);
  }, true);
}

installLightbox();
