import { readFileSync } from "node:fs";

export interface UpdaterReport { at: number; state: "current" | "pull-failed" | "refused"; backup: "ok" | "failed" }
export interface MainHead { sha: string; at: number }
export interface DeployStatus { level: "green" | "orange" | "red"; line: string; build: string }

const QUIET_MS = 10 * 60_000;
const BEHIND_MS = 20 * 60_000;
const span = (ms: number): string => ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 36 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} d`;
const ago = (ms: number): string => ms < 90_000 ? "just now" : `${span(ms)} ago`;

/** The dot an admin sees: red for what the updater gave up on, orange for what may still mend itself. */
export function deployStatus(build: string, updater: UpdaterReport | null, head: MainHead | null, now: number, since = now): DeployStatus {
  // The gateway starts with the container, so its uptime is how long this build has run.
  const short = `${build.slice(0, 7)} for ${span(now - since)}`;
  const say = (level: DeployStatus["level"], line: string): DeployStatus => ({ level, line, build });
  if (updater?.state === "refused") return say("red", `the newest image did not start; rolled back to ${build.slice(0, 7)}`);
  if (updater?.backup === "failed") return say("red", `the last backup failed; running ${short}`);
  if (updater?.state === "pull-failed") return say("orange", `the updater cannot pull the image; running ${short}`);
  if (updater && now - updater.at * 1000 > QUIET_MS) return say("orange", `the updater last checked ${ago(now - updater.at * 1000)}; running ${short}`);
  if (head && head.sha !== build && now - head.at > BEHIND_MS) return say("orange", `main is at ${head.sha.slice(0, 7)}, merged ${ago(now - head.at)}; still running ${short}`);
  if (head && head.sha !== build) return say("green", `${head.sha.slice(0, 7)} is on its way; running ${short}`);
  return say("green", `running ${short}${head ? ", the head of main" : ""}${updater ? `; updater checked ${ago(now - updater.at * 1000)}` : ""}`);
}

export function readUpdater(path: string): UpdaterReport | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdaterReport>;
    return typeof r.at === "number" && typeof r.state === "string" ? { at: r.at, state: r.state, backup: r.backup === "failed" ? "failed" : "ok" } as UpdaterReport : null;
  } catch { return null; }
}

/** The status for a published build, asking GitHub for main's head at most every ten minutes; null for a dev build. */
export function watchDeploy(build: string | undefined, repo: string | undefined, updaterPath = "/tmp/strata-updater.json"): (() => DeployStatus) | undefined {
  if (!build || build === "dev") return undefined;
  let head: MainHead | null = null, asked = 0;
  const since = Date.now();
  const ask = async (): Promise<void> => {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/commits/main`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "strata" }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const c = await r.json() as { sha?: string; commit?: { committer?: { date?: string } } };
      const at = Date.parse(c.commit?.committer?.date ?? "");
      if (c.sha && Number.isFinite(at)) head = { sha: c.sha, at };
    } catch { /* GitHub out of reach: the dot falls back to the updater's word alone */ }
  };
  return () => {
    const now = Date.now();
    if (repo && now - asked > 10 * 60_000) { asked = now; void ask(); }
    return deployStatus(build, readUpdater(updaterPath), head, now, since);
  };
}
