import { useEffect, useSyncExternalStore } from "react";
import { StrataGatewaySession } from "../data/api.ts";
let adminPath: string | null = null;
let asked = false;
const heard = new Set<() => void>();
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
const now = () => adminPath;

export function useAdminPath(): string | null {
  useEffect(() => {
    if (asked || !/^\/u\/[a-z0-9-]+(?:\/|$)/.test(location.pathname)) return;
    asked = true;
    StrataGatewaySession()
      .then((session) => {
        adminPath = session?.adminPath === "/admin" ? "/admin" : null;
        for (const cb of [...heard]) cb();
      })
      .catch(() => { asked = false; });
  }, []);
  return useSyncExternalStore(subscribe, now, now);
}
