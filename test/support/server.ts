// One hermetic server per test file: own port, own temp database, no developer keys or STRATA_* settings.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach } from "node:test";
import { freePort } from "./free-port.ts";
import { stopServer } from "./stop-server.ts";

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEST_COURSES = join(APP_DIR, "test", "fixtures", "courses");

export interface ServerOptions {
  env?: Record<string, string | undefined>;
  /** an existing database to boot over; the harness neither creates nor deletes it */
  db?: string;
  /** pass the developer's GEMINI_API_KEY through (only when STRATA_LIVE_TESTS=1) */
  live?: boolean;
}

export interface TestServer {
  base: string;
  port: number;
  db: string;
  live: boolean;
  api(path: string, init?: RequestInit): Promise<{ status: number; body: any }>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  output(from?: number): string;
  written(): number;
  stop(): Promise<void>;
}

const DEFAULTS: Record<string, string> = {
  STRATA_OPEN: "1",
  STRATA_COURSES: TEST_COURSES,
  STRATA_MIN_SECTION_WORDS: "1",
  GEMINI_API_KEY: "",
  TAVILY_API_KEY: "",
  FIRECRAWL_API_KEY: "",
};
export const KEEP_LOG = 256 * 1024;

/** Output kept within `limit` chars; offsets count everything ever written, so old marks stay valid. */
export function outputLog(limit = KEEP_LOG) {
  let log = "", dropped = 0;
  return {
    keep(chunk: Buffer | string) {
      log += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (log.length > limit) { dropped += log.length - limit / 2; log = log.slice(-limit / 2); }
    },
    output: (from = 0) => log.slice(Math.max(0, from - dropped)),
    written: () => dropped + log.length,
  };
}

export async function startServer(options: ServerOptions = {}): Promise<TestServer> {
  const own = options.db ? null : mkdtempSync(join(tmpdir(), "strata-it-"));
  const db = options.db ?? join(own!, "strata.db");
  let lastError: Error | null = null;
  // a free port can be taken before the server binds it; the server then exits (EADDRINUSE), so retry
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    try { return await boot(port, db, own, options); }
    catch (e) { lastError = e as Error; if (!(e as { retry?: boolean }).retry) break; }
  }
  if (own) rmSync(own, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  throw lastError;
}

async function boot(port: number, db: string, own: string | null, options: ServerOptions): Promise<TestServer> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("STRATA_")) env[k] = v;
  Object.assign(env, DEFAULTS);
  // GEMINI_API_KEY_FILE applies only while GEMINI_API_KEY is unset, so the default "" must be removed
  if (options.live && process.env.STRATA_LIVE_TESTS === "1") {
    if (process.env.GEMINI_API_KEY !== undefined) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    else delete env.GEMINI_API_KEY;
  }
  for (const [k, v] of Object.entries(options.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  Object.assign(env, { STRATA_PORT: String(port), STRATA_DB: db });

  const child: ChildProcess = spawn(process.execPath, ["server/main.ts"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const { keep, output, written } = outputLog();
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  const base = `http://127.0.0.1:${port}`;

  // Up means this child said it is listening on this port: a leftover server could answer health only.
  let live = false;
  const deadline = Date.now() + 60_000;   // a ceiling for a machine under load; a boot is ~0.5 s
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const said = output();
      throw Object.assign(new Error(`the test server exited before it was up:\n${said}`), { retry: /EADDRINUSE/.test(said) });
    }
    if (output().includes(`listening on ${base}`)) {
      try {
        const r = await fetch(base + "/api/health");
        if (r.ok) { live = !!(await r.json()).gemini; break; }
      } catch { /* not yet */ }
    }
    if (Date.now() > deadline) { await stopServer(child); throw new Error(`the test server did not come up in 60 s:\n${output()}`); }
    await new Promise((r) => setTimeout(r, 50));
  }

  const raw = (path: string, init?: RequestInit) => fetch(base + path, init);
  return {
    base, port, db, live, output, written,
    fetch: raw,
    async api(path, init) {
      const r = await raw(path, { headers: { "Content-Type": "application/json" }, ...init });
      return { status: r.status, body: r.status === 204 ? null : await r.json() };
    },
    async stop() {
      await stopServer(child);
      if (own) rmSync(own, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** `seed` runs in the boot's own `before`: node:test starts a top-level `before` once registered. */
export function useServer(options: ServerOptions & { seed?(server: TestServer): Promise<void> } = {}): TestServer {
  const server = {} as TestServer;
  let mark = 0;
  before(async () => {
    Object.assign(server, await startServer(options));
    await options.seed?.(server);
  });
  beforeEach(() => { mark = server.written ? server.written() : 0; });
  afterEach((t) => {
    if (t.passed || !server.output) return;
    const said = server.output(mark).trim();
    process.stderr.write(`\n── server output during "${t.name}" ──\n${said || "(nothing)"}\n── end of server output ──\n`);
  });
  after(async () => { await server.stop?.(); });
  return server;
}
