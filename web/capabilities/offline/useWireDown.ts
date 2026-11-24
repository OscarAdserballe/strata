import { useSyncExternalStore } from "react";
import { StrataWireDown, StrataWireWatch } from "../../data/api.ts";

/** True while the wire is known down: a control that needs the server greys out instead of failing when pressed. */
export const useWireDown = (): boolean => useSyncExternalStore(StrataWireWatch, StrataWireDown, () => false);
