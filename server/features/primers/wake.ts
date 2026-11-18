// A primer asked for outside a route (an agent's upload landing) wakes the routine as Send in Dispatch does.
import { recordRun, wake } from "../dashboard/routine.ts";

export function wakeLater(why: string): void {
  void wake(why).then((w) => { if (w.ran) recordRun(w.ran); }, (e) => console.error("[primer] the routine could not be woken:", e));
}
