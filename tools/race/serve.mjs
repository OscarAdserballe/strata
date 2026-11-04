// serveRoom({ label }): a fresh, seeded preview room on an OS-assigned port, for one check.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { assertFreshDist } from "../dist-fresh.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* every key the server could reach a paid provider with, emptied */
export const QUIET_ENV = { ...process.env, GEMINI_API_KEY: "", TAVILY_API_KEY: "", FIRECRAWL_API_KEY: "" };

export const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer().on("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function up(base, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) return false;
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Serve a fresh, seeded preview room. Throws if it cannot be brought up. */
export async function serveRoom({ port, label = "room", seed = true, env = {} } = {}) {
  assertFreshDist();
  const p = port || await freePort();
  const dir = mkdtempSync(join(tmpdir(), `strata-${label}-`));
  const db = join(dir, `${label}.db`);
  const base = `http://127.0.0.1:${p}`;
  const server = spawn(process.execPath, ["server/main.ts"], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"], env: { ...QUIET_ENV,
    STRATA_PORT: String(p), STRATA_OPEN: "1", STRATA_DB: db, STRATA_FAKE_MODEL: "1",
    STRATA_COURSES: join(REPO, "test", "fixtures", "courses"), STRATA_MIN_SECTION_WORDS: "100", ...env } });
  const kill = () => { try { server.kill(); } catch { } };
  process.on("exit", kill);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    kill();
    process.off("exit", kill);
    if (server.exitCode === null) await new Promise((r) => { server.once("exit", r); setTimeout(r, 3000); });
    // Windows may hold the file a moment longer than the process
    for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  };
  if (!(await up(base, server))) { await stop(); throw new Error(`the ${label} server did not come up`); }
  if (seed) {
    const seeded = spawnSync(process.execPath, ["tools/demo-seed.mjs", base], { cwd: REPO, stdio: "inherit", env: QUIET_ENV });
    if (seeded.status !== 0) { await stop(); throw new Error(`seeding the ${label} room failed`); }
  }
  return { base, db, dir, port: p, server, stop };
}
