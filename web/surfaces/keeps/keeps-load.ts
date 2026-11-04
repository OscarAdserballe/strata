import React, { useEffect, useState } from "react";
import { registerKeys } from "../../capabilities/keys/registry.ts";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { cardPrompt } from "../../capabilities/card/drill-order.ts";
import { facesOf } from "../../../shared/cards/faces.ts";
import { ago } from "../../shell/format.js";
import { nest, Line } from "../../engines/tree/ClaimTree.tsx";
import { liftSynthesis } from "../../engines/tree/tree.ts";
import CardForm, { EditButton, Preview } from "../../capabilities/card/CardForm.tsx";
import CardHistory from "../../capabilities/card/CardHistory.tsx";
import CardDeleted from "../../capabilities/card/CardDeleted.tsx";
import { deckOf, saveAuthored } from "../../capabilities/card/saveCard.ts";
import FeedbackNote from "../../capabilities/feedback/FeedbackNote.tsx";
import Ask from "../../capabilities/ask/Ask.tsx";
import { useProvideHere } from "../../shell/here.ts";
import { useEntity } from "../../data/store.ts";
import { holdKeeps, keeps, keepsKey } from "../../data/entities/keeps.ts";
import { room } from "../../shell/room.ts";
import { putKeepsAway } from "../../shell/screens.ts";

export type KeepsChunk = typeof import("./KeepsSurface.tsx");
export type { KeepCard } from "./KeepsSurface.tsx";

let loading: Promise<KeepsChunk> | null = null;
let loaded: KeepsChunk | null = null;

export function loadKeeps(): Promise<KeepsChunk> {
  loading ??= import("./KeepsSurface.tsx").then(
    (m) => {
      m.bind({ React, registerKeys, StrataAPI, StrataWhy, cardPrompt, facesOf, ago, nest, Line, liftSynthesis, CardForm, EditButton, Preview,
        CardHistory, CardDeleted, deckOf, saveAuthored, FeedbackNote, Ask, useProvideHere, useEntity, holdKeeps, keeps, keepsKey });
      loaded = m;
      return m;
    },
    (e) => { loading = null; throw e; },
  );
  return loading;
}

export const warmKeeps = (): void => { if (!loaded) loadKeeps().catch(() => {}); };

export function useKeepsChunk(): KeepsChunk | null {
  const [chunk, setChunk] = useState<KeepsChunk | null>(loaded);
  useEffect(() => {
    if (chunk) return;
    let live = true;
    loadKeeps().then((m) => { if (live) setChunk(m); },
      (e) => { if (live) { putKeepsAway(); room.toastWhy(e, "couldn't open the keeps"); } });
    return () => { live = false; };
  }, [chunk]);
  return chunk;
}
