import { parentPort, workerData } from 'node:worker_threads';
import { extractPdfStructure } from '../../../shared/reading/pdf-structure.ts';
import * as pdf from 'pdfjs-dist/legacy/build/pdf.mjs';

try {
  const structure = await extractPdfStructure(new Uint8Array(workerData.bytes),workerData.minimum,pdf,(page,total) => {
    parentPort!.postMessage({page,total});
  });
  parentPort!.postMessage({structure});
} catch (error) { parentPort!.postMessage({error:(error as Error).message}); }
