type Wire = any;

export interface BoardHand {
  activeId: string | null;
  board: Wire;
  pairs: Wire[];
  pair: Wire;
  pairIdx: number;
  onHome: boolean;
  src: Wire;
  go: { items: Array<{ run(): void; keepOpen?: boolean }>; sel: number } | null;
  composer: unknown;
  readonly capture: boolean;
  readonly launcher: boolean;
  readonly bench: unknown;
  readonly benchEdit: unknown;
  readonly sheetsOver: boolean;
}

let hand = {} as BoardHand;
export function holdBoardHand(next: BoardHand): void { hand = next; }
export const boardNow = (): BoardHand => hand;
