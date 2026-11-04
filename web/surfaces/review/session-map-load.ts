import React from "react";
import { PHONE } from "../../platform/device.js";
import { courseOf } from "../../shell/format.js";
import { StrataAPI } from "../../data/api.ts";
import ClaimTree, { Line, Met } from "../../engines/tree/ClaimTree.tsx";

export type SessionMapChunk = typeof import("./SessionMap.tsx");
export type { SessionMapProps } from "./SessionMap.tsx";

let loading: Promise<SessionMapChunk> | null = null;
let loaded: SessionMapChunk | null = null;

export function loadSessionMap(): Promise<SessionMapChunk> {
  loading ??= import("./SessionMap.tsx").then(
    (m) => { m.bind({ React, PHONE, courseOf, StrataAPI, ClaimTree, Line, Met }); loaded = m; return m; },
    (e) => { loading = null; throw e; },
  );
  return loading;
}

export const sessionMapNow = (): SessionMapChunk | null => loaded;
