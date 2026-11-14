import { createPortal } from "react-dom";
import ReviewSurface from "./ReviewSurface.tsx";
import { room, useRoomHost } from "../../shell/room.ts";
import { setReviewing } from "../../shell/screens.ts";
import { reviewStrip } from "../../data/entities/review.ts";
import { setComposer, useComposer } from "../../capabilities/card/composing.ts";
import { compose, saveCardEdit, saveComposed } from "../../capabilities/card/doors.ts";
import { ImportsStatus } from "../../capabilities/sources/ImportsPanel.tsx";
import { addSourceFrom } from "../../capabilities/sources/BoardPicker.tsx";
import TopNav from "../../shell/TopNav.tsx";
import { signOut } from "../../shell/signOut.ts";
import { useAdminPath } from "../../shell/session.ts";

const away = (board: string, resource?: string | null) => { setReviewing(false); void room.openBoard(board, resource || undefined); };

export default function ReviewScreen() {
  const host = useRoomHost("veil");
  const composer = useComposer();
  const adminPath = useAdminPath();
  return host && createPortal(<>
    <ReviewSurface initial={reviewStrip.fresh()} onClose={() => { reviewStrip.spend(); setReviewing(false); reviewStrip.refresh(); }}
      composer={composer} onNewCard={compose}
      onComposerSave={saveComposed} onComposerCancel={() => setComposer(null)}
      onEditSave={saveCardEdit} onDeleteCard={room.deleteCard}
      onOpen={(t: { board: string; resource?: string | null }) => away(t.board, t.resource)}
      nav={<TopNav here="review" adminPath={adminPath} onSignOut={() => signOut((e) => room.toastWhy(e, "couldn't sign out"))}
        onAdd={(kind, study) => addSourceFrom(kind, { activeId: room.activeId(), libraryUp: true, newBoard: room.newBoard }, study)} />} />
    <ImportsStatus floating className="" onOpen={away} />
  </>, host);
}
