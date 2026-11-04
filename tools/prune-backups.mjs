#!/usr/bin/env node
import { readdirSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (positional.length !== 1) { console.error("usage: node tools/prune-backups.mjs DIR [--dry-run]"); process.exit(2); }
const dir = resolve(positional[0]);
const dryRun = process.argv.includes("--dry-run");

const stamp = /-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db$/;
const files = readdirSync(dir).flatMap((name) => {
  const match = name.match(stamp);
  if (!match) return [];
  const [, year, month, day, hour, minute, second] = match;
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(time) ? [{ name, path: resolve(dir, name), time }] : [];
}).sort((a, b) => b.time - a.time);

if (!files.length) { console.log(`no timestamped backups in ${dir}`); process.exit(0); }

const newest = files[0].time;
const day = 86400_000;
const keep = new Set([files[0].path]);
const buckets = new Set();
for (const file of files) {
  const age = newest - file.time;
  let bucket;
  if (age < 7 * day) bucket = `day:${new Date(file.time).toISOString().slice(0, 10)}`;
  else if (age < 28 * day) {
    const thursday = new Date(file.time);
    thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
    bucket = `week:${thursday.getUTCFullYear()}-${Math.ceil((((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / day) + 1) / 7)}`;
  } else if (age < 183 * day) bucket = `month:${new Date(file.time).toISOString().slice(0, 7)}`;
  if (bucket && !buckets.has(bucket)) { buckets.add(bucket); keep.add(file.path); }
}

const remove = files.filter((file) => !keep.has(file.path));
for (const file of remove) {
  if (!dryRun) unlinkSync(file.path);
  console.log(`${dryRun ? "would remove" : "removed"} ${basename(file.path)} (retention)`);
}
console.log(`${dryRun ? "would keep" : "kept"} ${keep.size} of ${files.length} timestamped backups in ${dir}`);
