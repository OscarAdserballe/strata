import { StrataPath } from "../../data/api.ts";
type PdfJs = typeof import("pdfjs-dist");
let runtime: Promise<PdfJs> | undefined;
export function loadPdf(): Promise<PdfJs> {
  return runtime ??= import("pdfjs-dist").then(pdf => {
    pdf.GlobalWorkerOptions.workerSrc = StrataPath("/pdf.worker.min.js");
    return pdf;
  }).catch(error => { runtime = undefined; throw error; });
}

// One shared reader worker instead of one per document; replaced after 16 documents.
type Worker = InstanceType<PdfJs["PDFWorker"]>;
const DOCS_PER_WORKER = 16;
let worker: Worker | undefined, served = 0;
const holding = new Map<Worker, number>();
const retired = new Set<Worker>();
export async function readerWorker(): Promise<Worker> {
  const pdf = await loadPdf();
  if (worker && (worker.destroyed || served >= DOCS_PER_WORKER)) { retired.add(worker); endIfIdle(worker); worker = undefined; }
  if (!worker) { worker = new pdf.PDFWorker(); served = 0; }
  served++;
  holding.set(worker, (holding.get(worker) ?? 0) + 1);
  return worker;
}
export function releaseWorker(w: Worker | undefined): void {
  if (!w) return;
  holding.set(w, Math.max(0, (holding.get(w) ?? 1) - 1));
  endIfIdle(w);
}
function endIfIdle(w: Worker): void {
  if (!retired.has(w) || (holding.get(w) ?? 0) > 0) return;
  retired.delete(w); holding.delete(w);
  if (!w.destroyed) w.destroy();
}

// Preload pdf.js and its worker at idle and on pointerdown so the first open doesn't wait.
export function warmPdf(): void {
  loadPdf().then((pdf) => {
    if (!worker || worker.destroyed) { worker = new pdf.PDFWorker(); served = 0; }
    return worker.promise;
  }).catch(() => { /* the reader will say so if it cannot open */ });
}

/** pdf.js image decoders (JBig2, JPEG 2000); without them scanned pages draw with images missing. */
export const pdfWasmUrl = (): string => StrataPath("/dist/pdfjs/");
