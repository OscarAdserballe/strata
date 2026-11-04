import { once } from "node:events";
import type { ChildProcess } from "node:child_process";

/** Release SQLite handles before removing a server's temporary database. */
export async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill();
  await closed;
}
