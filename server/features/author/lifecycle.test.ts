// STRATA_DB is set before the imports because db.ts opens its file at import time.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STRATA_DB = join(tmpdir(), `strata-lifecycle-${process.pid}.db`);

const { db } = await import("../../platform/db/db.ts");
const { q } = await import("../repo.ts");
const { now } = await import("../../platform/db/sql.ts");
const { applyKeptQuestions } = await import("./lifecycle.ts");

// Closed first: Windows will not delete a file a connection still holds.
after(() => { try { db.close(); rmSync(process.env.STRATA_DB as string, { force: true }); } catch { /* scratch */ } });

test("the bulk replay skips tombstones and rebuilds the lead ords in keep order", () => {
  const t = now();
  q.upsertCourse.run("src-x", "The scratch deck", null, t);
  q.insCard.run("src-x/flashcard/base", "src-x", "src-x/0-flashcard", "flashcard", JSON.stringify({ front: "base", back: "b", id: "src-x/flashcard/base" }), 0);
  const mint = (mid: string, front: string, cid: string) => {
    q.insMinted.run(mid, "b-x", null, "bare", "closed", front, "mine.", "asked", "{}", 0, t, t);
    q.setMintedCard.run(cid, t, "b-x", mid);
  };
  mint("m-1", "first?", "src-x/yours/first");
  mint("m-2", "second?", "src-x/yours/second");
  mint("m-3", "dropped?", "src-x/yours/dropped");
  q.insKeep.run("src-x/yours/first", "src-x", "src-x/yours", t + 1);
  q.insKeep.run("src-x/yours/second", "src-x", "src-x/yours", t + 2);
  q.insDrop.run("src-x/yours/dropped", "src-x", "src-x/yours", "flashcard", "{}", -9, t);

  applyKeptQuestions();

  const rows = q.cardsOf.all("src-x") as { id: string; ord: number }[];
  const ords = new Map(rows.map((r) => [r.id, r.ord]));
  assert.ok(!ords.has("src-x/yours/dropped"), "dropped stays dropped — no resurrection, no restore collision");
  assert.ok(ords.has("src-x/yours/first") && ords.has("src-x/yours/second"), "the kept pair is back");
  assert.ok((ords.get("src-x/yours/second") as number) < (ords.get("src-x/yours/first") as number),
    "keep order rebuilt: the later keep took the lower lead ord, exactly as the live session wrote it");
  assert.ok((ords.get("src-x/yours/first") as number) < 0, "…and both lead the deck");

  const before = JSON.stringify(rows);
  applyKeptQuestions();
  assert.equal(JSON.stringify(q.cardsOf.all("src-x")), before, "a replay over a whole deck is a no-op");
});
