import { Worker } from "node:worker_threads";
import { MIN_SECTION_WORDS } from "../../platform/config.ts";
import { background } from "../../platform/background.ts";
import type { ImportHeading } from "../../../shared/imports/import-plan.ts";

/** A stored PDF's outline, read off the main thread by the same worker an import uses. */
export function readOutline(bytes: Buffer): Promise<ImportHeading[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), { workerData: { bytes, minimum: MIN_SECTION_WORDS } });
    const timeout = setTimeout(() => { reject(new Error("reading the PDF's contents timed out")); background("outline worker", worker.terminate()); }, 5 * 60_000);
    worker.on("message", (message) => {
      if (message.error) reject(new Error(message.error));
      else if (message.structure) resolve(message.structure.outline);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`reading the PDF stopped (${code})`)); });
  });
}
