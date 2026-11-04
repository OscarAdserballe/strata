import { useEffect } from "react";
import { createPortal } from "react-dom";
import LibraryHome from "./LibraryHome.tsx";
import { room, useHeldId, useRoomHost } from "../../shell/room.ts";
import { CRAM, REVIEW, screensNow, setLibrary, setLibraryQuery, setReviewing, useScreens, useScreensUp } from "../../shell/screens.ts";
import { readRoute, routeBoard } from "../../shell/routes.ts";
import { signOut } from "../../shell/StatusBar.tsx";
import { useAdminPath } from "../../shell/session.ts";
import { reviewStrip, useReviewStrip } from "../../data/entities/review.ts";
import { refreshBoards } from "../../data/entities/register.ts";
import { registerLadder } from "../../capabilities/keys/registry.ts";
import { begin as journey } from "../../platform/rum.ts";

const bootRoute = readRoute(location.search);
let opened = false;
const close = () => setLibrary(false);

export default function LibraryScreen() {
  const host = useRoomHost("library");
  const up = useScreensUp();
  const q = useScreens().libraryQuery;
  const held = useHeldId();
  const review = useReviewStrip();
  const adminPath = useAdminPath();
  // refetch on reopen (the list is ordered by last touch); a failed fetch keeps the current list
  const drawn = !!host, reviewing = !!(up & REVIEW);
  useEffect(() => reviewStrip.prime(), []);
  useEffect(() => {
    if (!drawn || reviewing) return;
    if (opened || routeBoard(bootRoute) || bootRoute.kind === "review") refreshBoards();
    opened = true;
    // due counts depend on the time, so refetch them with the list (the boot read, just sent, still stands)
    if (!reviewStrip.justPrimed()) reviewStrip.refresh();
  }, [drawn, reviewing]);
  useEffect(() => registerLadder(() => ({ veil: { open: () => screensNow().library && !!room.activeId(), close } })), []);
  return host && createPortal(
    <LibraryHome covered={!!(up & (REVIEW | CRAM))} q={q} setQ={setLibraryQuery}
      onOpen={room.openBoard} onNew={() => room.newBoard(q)}
      onResume={(id: string) => { journey("continue"); void room.openBoard(id, undefined, { resume: true }); }}
      onWarm={room.warmBoard} onCardsChanged={reviewStrip.refresh}
      review={review} onReview={() => { journey("review.open"); setReviewing(true); }}
      onSourceMutation={room.sourceMutated}
      onLogout={() => signOut((e) => room.toastWhy(e, "couldn't sign out"))}
      adminPath={adminPath} onClose={held ? close : null} boardActions={room.boardActions} />,
    host);
}
