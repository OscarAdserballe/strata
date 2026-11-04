/** Reads only the bounded window and O(log n) offsets during a scroll. */
export function pageWindow<T extends { offsetTop: number; offsetHeight: number }>(pages: readonly T[], top: number, bottom: number): T[] {
  let lo=0, hi=pages.length;
  while(lo<hi) {
    const mid=(lo+hi)>>>1, page=pages[mid];
    if(page.offsetTop+page.offsetHeight<top)lo=mid+1; else hi=mid;
  }
  const out:T[]=[];
  for(let i=lo;i<pages.length && pages[i].offsetTop<=bottom;i++)out.push(pages[i]);
  return out;
}

// Draw-ahead budget in page heights: small for iPad memory, and deferred until the scroll pauses.
export const DRAW_AHEAD = 1.5, DRAW_BEHIND = 0.5, KEEP_AHEAD = 2, KEEP_BEHIND = 1, WHILE_MOVING = 0.25, SETTLE_MS = 160;
// Small scrolls are scroll anchoring reacting to sub-pixel placeholder changes, not the reader moving.
export const NUDGE_PX = 2;
