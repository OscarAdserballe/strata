import React, { useEffect, useState } from "react";
import { registerKeys } from "../../capabilities/keys/registry.ts";
import { cardPrompt } from "../../capabilities/card/drill-order.ts";
import { facesOf } from "../../../shared/cards/faces.ts";
import { TOUCH, PHONE } from "../../platform/device.js";
import { StrataAPI } from "../../data/api.ts";
import { begin, end as arrived } from "../../platform/rum.ts";
import CardForm from "../../capabilities/card/CardForm.tsx";
import CardMeta from "../../capabilities/card/CardMeta.tsx";
import CardHistory from "../../capabilities/card/CardHistory.tsx";
import { deckOf } from "../../capabilities/card/saveCard.ts";
import CardControls, { gradeActions } from "../../capabilities/card/CardControls.tsx";
import CardFace from "../../capabilities/card/CardFace.tsx";
import Ask from "../../capabilities/ask/Ask.tsx";
import { closeAsk, openAsk } from "../../capabilities/ask/control.ts";
import { cardThreadKey } from "../../capabilities/ask/threads.ts";
import { useProvideHere } from "../../shell/here.ts";
import Composer from "../../capabilities/card/Composer.tsx";
import { room } from "../../shell/room.ts";
import { closeCram } from "../../shell/screens.ts";

export type CramChunk = typeof import("./CramSurface.tsx");
export type { CramCard } from "./CramSurface.tsx";

let loading: Promise<CramChunk> | null = null;
let loaded: CramChunk | null = null;

export function loadCram(): Promise<CramChunk> {
  loading ??= import("./CramSurface.tsx").then(
    (m) => {
      m.bind({ React, TOUCH, PHONE, registerKeys, cardPrompt, facesOf, StrataAPI, begin, arrived, CardForm, CardMeta, CardHistory, deckOf,
        CardControls, gradeActions, CardFace, Ask, closeAsk, openAsk, cardThreadKey, useProvideHere, Composer });
      loaded = m;
      return m;
    },
    (e) => { loading = null; throw e; },
  );
  return loading;
}

export const warmCram = (): void => { if (!loaded) loadCram().catch(() => {}); };

export function useCramChunk(): CramChunk | null {
  const [chunk, setChunk] = useState<CramChunk | null>(loaded);
  useEffect(() => {
    if (chunk) return;
    let live = true;
    loadCram().then((m) => { if (live) setChunk(m); },
      (e) => { if (live) { closeCram(); room.toastWhy(e, "couldn't open the cram"); } });
    return () => { live = false; };
  }, [chunk]);
  return chunk;
}
