import { useEffect, useSyncExternalStore } from "react";
import { StrataGatewaySession, type DeployStatus } from "../data/api.ts";
let adminPath: string | null = null;
let deploy: DeployStatus | null = null;
let asked = 0;
const STALE_MS = 5 * 60_000;
const heard = new Set<() => void>();
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
const nowPath = () => adminPath;
const nowDeploy = () => deploy;

function ask(): void {
  if ((asked && Date.now() - asked < STALE_MS) || !/^\/u\/[a-z0-9-]+(?:\/|$)/.test(location.pathname)) return;
  asked = Date.now();
  StrataGatewaySession()
    .then((session) => {
      const path = session?.adminPath === "/admin" ? "/admin" : null, d = session?.deploy ?? null;
      if (path === adminPath && d?.level === deploy?.level && d?.line === deploy?.line) return;
      adminPath = path; deploy = d;
      for (const cb of [...heard]) cb();
    })
    .catch(() => { asked = 0; });
}

// No timer: the session is asked again only when the tab comes back after five minutes.
let watching = false;
function watch(): void {
  ask();
  if (watching) return;
  watching = true;
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ask(); });
}

export function useAdminPath(): string | null {
  useEffect(watch, []);
  return useSyncExternalStore(subscribe, nowPath, nowPath);
}

/** How the deploy stands, for an admin; null for everyone else. */
export function useDeploy(): DeployStatus | null {
  useEffect(watch, []);
  return useSyncExternalStore(subscribe, nowDeploy, nowDeploy);
}
