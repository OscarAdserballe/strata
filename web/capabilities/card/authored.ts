import type { Minted } from "../../../shared/types/index.ts";

type AuthoredRow = Minted & { boardId?: string; boardTitle?: string };

export type AuthoredCard = {
  id: string;
  mintId: string;
  type: "flashcard";
  front: string;
  back: string;
  source: string;
  node: string;
  ord: number;
  mine: true;
  variant: string;
  mintOpen: boolean;
  meta: Record<string, unknown>;
  opensAt: number;
  deck: string | null;
  pairId: string | null;
  boardId: string;
  boardTitle: string;
};

export function mintedToCards(minted: AuthoredRow[] | null | undefined, boardId: string): AuthoredCard[] {
  return (minted || []).filter((m) => !m.cardId).map((m) => ({
    id: "mint:" + m.id, mintId: m.id, type: "flashcard",
    front: m.front, back: m.back || "",
    source: m.source || "asked in the thread",
    node: "n1",
    ord: m.createdAt, mine: true, variant: m.variant,
    mintOpen: m.state !== "closed", meta: m.meta || {}, opensAt: m.opensAt || 0,
    deck: m.deck || null,
    // enrol where the question was found, not whichever page is open when it is closed
    pairId: m.pairId || null,
    boardId: m.boardId || boardId, boardTitle: m.boardTitle || "",
  }));
}

export interface QuestionDeck { kind: string; name: string; cards: AuthoredCard[] }
export interface Containment { qGroups: QuestionDeck[]; inDrill: AuthoredCard[] }

export function boardContainment(mine: AuthoredCard[]): Containment {
  return { qGroups: [{ kind: "board", name: "your questions", cards: mine }], inDrill: [] };
}
