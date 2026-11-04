import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RoomSpec { key: string; basePath: string; port: number; dataDir: string }

const MAIN = join(import.meta.dirname, "..", "main.ts");

// One process per room: the server keeps a single global database connection.
export function startRooms(rooms: RoomSpec[], env: NodeJS.ProcessEnv = process.env): () => void {
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  const start = (room: RoomSpec, delay = 1000): void => {
    mkdirSync(room.dataDir, { recursive: true });
    const child = spawn(process.execPath, [MAIN], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...env, STRATA_HOST: "127.0.0.1", STRATA_PORT: String(room.port), STRATA_DATA: room.dataDir, STRATA_BASE_PATH: room.basePath, STRATA_OPEN: "1" },
    });
    const startedAt = Date.now();
    children.set(room.key, child);
    child.on("exit", (code, signal) => {
      if (stopping) return;
      // a room that stayed up a minute restarts at once; one that keeps dying backs off to 30 s
      const wait = Date.now() - startedAt > 60_000 ? 1000 : Math.min(delay * 2, 30_000);
      console.error(`room ${room.key} exited (${signal ?? code}); restarting in ${wait / 1000} s`);
      setTimeout(() => start(room, wait), wait).unref();
    });
  };
  for (const room of rooms) start(room);
  return () => { stopping = true; for (const child of children.values()) child.kill("SIGTERM"); };
}
