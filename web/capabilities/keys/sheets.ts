export type KeyRow = readonly [keys: string, what: string];
export type KeyGroup = readonly [title: string, rows: readonly KeyRow[]];

export const ROOM: readonly KeyGroup[] = [
  ["the deck", [
    ["space", "reveal — the grade is what moves you on"],
    ["⇧space", "back"],
    ["n / p", "next / previous card"],
    ["1–4", "answer a multiple choice (then 1/2 judge it, like any card)"],
    ["1 / 2", "missed / got it — the grade is what moves you on (unrevealed, they reveal)"],
    ["↵", "show me where this card lives (shuffled: goes to its page)"],
    ["e", "rewrite this card in your own words (⌘↵ formats · esc leaves)"],
    ["c", "make a card of the thread's last answer (the card button makes one from scratch)"],
    ["r", "the keeps — choose what to keep of this deck (on home: the whole board; in the library: every board · r or esc leaves)"],
  ]],
  ["the page", [
    ["j / k", "scroll"],
    ["^d / ^u", "half a page"],
    ["pinch", "zoom the page alone — now {pz}%"],
    ["t", "the source ⇄ its concept tree"],
    ["f", "find in the source (↵ next · ⇧↵ back · esc leaves)"],
    ["o", "only the cards — the whole board, shuffled"],
    ["x", "cram — the sources you choose, drilled in rounds, off the review schedule"],
  ]],
  ["marking", [
    ["select", "drag over a passage — highlight / note comes up over it"],
    ["click", "a highlight — open its note"],
    ["esc", "close the note (it saves)"],
    ["⌘Z / ⌘Y", "take back the last mark / put it back (⇧⌘Z too)"],
    ["remove", "in the open note, to take the mark back"],
  ]],
  ["moving", [
    ["h", "the board page — everything on this board under your own groups, its purpose and milestones"],
    ["esc", "back to the card (the desk never keeps it); in the library, back to the board"],
    ["click a book", "step inside it — ‹ steps back out"],
    ["click a row", "open it"],
    ["b", "all boards"],
  ]],
  ["the room", [
    ["-  /  =", "smaller / larger — now {ui}%"],
    ["↓ / ↑", "in the board picker: move (j / k too) — ↵ picks, esc leaves"],
    ["← / →", "in the tour: the previous / next scene"],
  ]],
];

export const REVIEW: readonly KeyGroup[] = [
  ["the review", [
    ["space", "reveal — the grade is what moves you on"],
    ["1–4", "answer a multiple choice"],
    ["1 / 2", "missed / got it (unrevealed, they reveal)"],
    ["↵", "show me where this card lives, once answered"],
    ["e", "rewrite this card (⌘↵ formats · esc leaves)"],
    ["esc", "the editor, then the thread, then the sitting: once into the map, once out of it"],
  ]],
];

export const CRAM: readonly KeyGroup[] = [
  ["the cram", [
    ["↵ / space", "on the chooser: start the round"],
    ["space", "reveal"],
    ["1–4", "answer a multiple choice"],
    ["1 / 2", "missed / got it — off the review schedule (unrevealed, they reveal); at a round's end, again with the missed / with all"],
    ["d", "drop the card from this cram — not on the exam (the card itself stays)"],
    ["e", "rewrite this card (⌘↵ formats · esc leaves)"],
    ["↵", "show me where this card lives, once answered"],
    ["esc", "the editor, the thread, then the round → the chooser → the board"],
  ]],
];

export const KEEPS: readonly KeyGroup[] = [
  ["the keeps", [
    ["↓ / ↑ · j / k", "move through the deck"],
    ["↵", "read the card under the cursor — again folds it"],
    ["s", "keep it / let it go — the ○ at a row's left does the same by hand"],
    ["e", "rewrite the card under the cursor (its editor deletes it too)"],
    ["click a row", "reads it"],
    ["esc", "one level back up: the deck → its board → the library"],
  ]],
];

export const EVERYWHERE: readonly KeyGroup[] = [
  ["everywhere", [
    ["/", "ask — the thread of what is on screen"],
    ["esc", "close the top thing: this sheet, the thread, the screen laid over the room"],
    ["?", "this sheet"],
  ]],
];

export const SHEETS: Readonly<Record<string, readonly KeyGroup[]>> = { board: ROOM, review: REVIEW, cram: CRAM, keeps: KEEPS };
