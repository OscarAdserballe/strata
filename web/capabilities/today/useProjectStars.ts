import { useEffect, useState } from "react";
import type { ProjectEntry, RegisterResponse } from "../../../shared/types/index.ts";
import { plan, planGestures } from "../../data/entities/plan.ts";
import { refreshRegister } from "../../data/entities/register.ts";
import { StrataWhy } from "../../data/api.ts";

/** A project's star from a list of projects: painted at once, saved through the board's plan, then the register is read again. */
export function useProjectStars(reg: RegisterResponse | null, onError: (why: string) => void) {
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  useEffect(() => { setFlipped({}); }, [reg]);
  const starred = (p: ProjectEntry): boolean => flipped[p.id] ?? !!p.starredAt;
  function toggle(p: ProjectEntry): void {
    const next = !starred(p);
    setFlipped((f) => ({ ...f, [p.id]: next }));
    plan.write(p.id, planGestures.project({ starred: next }))
      .catch((e: unknown) => { setFlipped((f) => { const { [p.id]: _, ...rest } = f; return rest; }); onError(StrataWhy(e, "couldn't star that")); })
      .finally(() => refreshRegister());
  }
  return { starred, toggle };
}
