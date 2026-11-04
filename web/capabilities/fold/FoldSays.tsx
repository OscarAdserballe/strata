import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { mdBlocks } from "../../engines/prose/blocks.tsx";
import { says } from "./says.ts";

/** The answers in the open source's ask folds, drawn as the dock draws them. */
export default function FoldSays() {
  const slots = useSyncExternalStore(says.subscribe, says.get);
  return <>{slots.map((s) => createPortal(mdBlocks(s.text, s.streaming), s.el, s.key))}</>;
}
