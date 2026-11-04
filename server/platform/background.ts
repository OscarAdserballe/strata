// Node treats an unhandled rejection as fatal: unawaited work must log its failure, not crash the room.

export function background(what: string, job: Promise<unknown>, failed?: (error: unknown) => void): void {
  job.catch((error: unknown) => {
    console.error(`[${what}] failed in the background:`, error);
    if (!failed) return;
    try { failed(error); } catch (again) { console.error(`[${what}] could not be marked failed:`, again); }
  });
}

interface ProcessLike {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
}

export function guardProcess(
  target: ProcessLike = process,
  log: (...args: unknown[]) => void = console.error,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  target.on("unhandledRejection", (reason) => log("strata: a background promise failed and nothing caught it (still serving):", reason));
  target.on("uncaughtException", (error) => {
    log("strata: uncaught exception, exiting:", error);
    exit(1);
  });
}
