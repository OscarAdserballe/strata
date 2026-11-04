import type { Card } from "../../../shared/types/index.ts";

export interface DrillCard extends Partial<Pick<Card, "id" | "type" | "ord">>, Record<string, unknown> {
  deck?: Card["deck"] | null;
  introduces?: unknown;
  node?: string | null;
}

export function levelOf(c: DrillCard | null | undefined): number {
  if (c && c.introduces) return 0; // a term leads however deep in the tree it was written
  const m = String((c && c.node) || "").match(/^n(\d+(?:\.\d+)*)/);
  return m ? m[1].split(".").length : 1;
}

export const SKIM = 0;
export const DEEPER = 1;
export const STAGE_NAME: Record<number, string> = { [SKIM]: "first skim", [DEEPER]: "deeper pass" };
export const REVIEW_NAME = "review";

export const stageOf = (c: DrillCard | null | undefined): number => (levelOf(c) <= 1 ? SKIM : DEEPER);

export const byStage = (a: DrillCard, b: DrillCard): number => {
  const sa = stageOf(a), sb = stageOf(b);
  if (sa !== sb) return sa - sb;
  if (sa === SKIM) { const la = levelOf(a), lb = levelOf(b); if (la !== lb) return la - lb; }
  return (a.ord || 0) - (b.ord || 0);
};

export const stagesOf = (cards: DrillCard[] | null | undefined): number[] =>
  Array.from(new Set((cards || []).map(stageOf))).sort((x, y) => x - y);

// kept for the log: card events still record the layer, so old and new rows read alike
export const byPass = (a: DrillCard, b: DrillCard): number =>
  levelOf(a) - levelOf(b) || (a.ord || 0) - (b.ord || 0);
export const passesOf = (cards: DrillCard[] | null | undefined): number[] =>
  Array.from(new Set((cards || []).map(levelOf))).sort((x, y) => x - y);

export const cardPrompt = (c: Card | DrillCard): unknown =>
  c.type === "mcq" ? c.stem : c.type === "trick" ? c.problem : c.front;


