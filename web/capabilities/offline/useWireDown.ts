import { useSyncExternalStore } from "react";
import { StrataWireDown, StrataWireWatch } from "../../data/api.ts";

/** True while the wire is known down: a control that needs the server greys out instead of failing when pressed. */
export const useWireDown = (): boolean => useSyncExternalStore(StrataWireWatch, StrataWireDown, () => false);

/** Settles once the wire is known down; a save already in flight uses it to shelve itself instead of hanging. */
export function untilWireDown(): { down: Promise<void>; stop: () => void } {
  let stop = () => {};
  const down = new Promise<void>((resolve) => {
    if (StrataWireDown()) return resolve();
    const off = StrataWireWatch(() => { if (StrataWireDown()) { off(); resolve(); } });
    stop = off;
  });
  return { down, stop: () => stop() };
}
