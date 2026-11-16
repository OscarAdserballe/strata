import { Fragment, type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { LAYERS, type LayerName, subscribeToast, toastNow } from "./layers.ts";
import KeysSheet from "../capabilities/keys/KeysSheet.tsx";
import SaveChip from "./SaveChip.tsx";
import Pad from "../capabilities/pad/Pad.tsx";
import { closePad, padOpen } from "../capabilities/pad/pad.ts";
import { type LayerClosers, registerLadder } from "../capabilities/keys/registry.ts";

// `esc` is read through a ref so the esc ladder is registered once, not on every render.
export type LayerSlots = Partial<Record<LayerName, ReactNode>>;

export default function Layers({ slots, esc }: { slots: LayerSlots; esc?: LayerClosers }) {
  const ladder = useRef(esc);
  ladder.current = esc;
  useEffect(() => registerLadder(() => ({ pad: { open: padOpen, close: closePad }, ...ladder.current })), []);
  const all: LayerSlots = { ...slots, saving: <SaveChip />, pad: <Pad />, toast: <Toast />, sheet: <><KeysSheet />{slots.sheet}</> };
  return <>{LAYERS.map(([name]) => all[name] == null ? null : <Fragment key={name}>{all[name]}</Fragment>)}</>;
}

// Its own subscription, so showing a toast re-renders only this.
function Toast() {
  const said = useSyncExternalStore(subscribeToast, toastNow, () => "");
  return said ? <div className="toast">{said}</div> : null;
}
