// Test-only preload: logs every statement the server runs as `[run] <sql>`.
import { StatementSync } from "node:sqlite";

for (const name of ["all", "get", "run", "iterate"]) {
  const original = StatementSync.prototype[name];
  StatementSync.prototype[name] = function (...args) {
    process.stdout.write(`[run] ${String(this.sourceSQL).replace(/\s+/g, " ").trim().slice(0, 160)}\n`);
    return original.apply(this, args);
  };
}
