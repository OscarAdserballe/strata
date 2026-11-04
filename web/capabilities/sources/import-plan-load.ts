import React from "react";
import { createPortal } from "react-dom";

// fetched beside the groups and started on pointerdown, so the click waits on one round trip
export type ImportPlanChunk = typeof import("./ImportPlan.tsx");

let loading: Promise<ImportPlanChunk> | null = null;
let loaded: ImportPlanChunk | null = null;

export function loadImportPlan(): Promise<ImportPlanChunk> {
  loading ??= import("./ImportPlan.tsx").then(
    (m) => { m.bind({ React, createPortal }); loaded = m; return m; },
    (e) => { loading = null; throw e; },               // a failed fetch may be retried
  );
  return loading;
}

export const importPlanNow = (): ImportPlanChunk | null => loaded;
