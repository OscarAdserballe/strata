// Test-only preload: logs every statement the server prepares as `[prepare] <file>:<line> <sql>`.
import { DatabaseSync } from "node:sqlite";

const prepare = DatabaseSync.prototype.prepare;
const CALLER = /\((?:file:\/\/\/?)?(.*?[\\/](?:server|experiments)[\\/][^)]*?):(\d+):\d+\)/;

DatabaseSync.prototype.prepare = function (sql, ...rest) {
  const frame = (new Error().stack ?? "").split("\n").slice(2).map((l) => CALLER.exec(l)).find(Boolean);
  const where = frame ? `${frame[1].replace(/\\/g, "/").replace(/^.*?\/(server|experiments)\//, "$1/")}:${frame[2]}` : "?";
  process.stdout.write(`[prepare] ${where} ${String(sql).replace(/\s+/g, " ").slice(0, 100)}\n`);
  return prepare.call(this, sql, ...rest);
};
