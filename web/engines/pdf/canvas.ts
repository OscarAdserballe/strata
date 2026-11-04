// Cap each bitmap regardless of page size and zoom, to bound graphics memory.
export const PDF_CANVAS_MAX_PIXELS = 2 * 1024 * 1024;
export const PDF_CANVAS_MAX_SIDE = 4096;

export function pdfCanvasScale(width: number, height: number, requested: number): number {
  return Math.min(requested, Math.sqrt(PDF_CANVAS_MAX_PIXELS / (width * height)),
    PDF_CANVAS_MAX_SIDE / width, PDF_CANVAS_MAX_SIDE / height);
}

export function releasePdfCanvas(canvas: HTMLCanvasElement): void {
  // Removing a DOM node alone need not release its graphics backing store promptly.
  canvas.width = canvas.height = 0;
  canvas.remove();
}
