import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { transaction } from "./transaction.ts";

function room(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v TEXT)");
  return db;
}
const values = (db: DatabaseSync) => db.prepare("SELECT v FROM t ORDER BY rowid").all().map((r) => r.v);
const add = (db: DatabaseSync, v: string) => db.prepare("INSERT INTO t VALUES (?)").run(v);

test("a transaction commits its block and returns its value", () => {
  const db = room();
  assert.equal(transaction(db, () => { add(db, "a"); add(db, "b"); return 2; }), 2);
  assert.deepEqual(values(db), ["a", "b"]);
  assert.equal(db.isTransaction, false);
});

test("a throw rolls everything back and is rethrown unchanged", () => {
  const db = room();
  const boom = new Error("boom");
  assert.throws(() => transaction(db, () => { add(db, "a"); throw boom; }), (e) => e === boom);
  assert.deepEqual(values(db), []);
  assert.equal(db.isTransaction, false);
});

test("a transaction inside a transaction nests as a savepoint instead of failing", () => {
  const db = room();
  transaction(db, () => {
    add(db, "outer");
    transaction(db, () => { assert.equal(db.isTransaction, true); add(db, "inner"); });
  });
  assert.deepEqual(values(db), ["outer", "inner"]);
  assert.equal(db.isTransaction, false);
});

test("an inner throw the caller catches undoes only the inner savepoint", () => {
  const db = room();
  transaction(db, () => {
    add(db, "before");
    assert.throws(() => transaction(db, () => {
      add(db, "inner");
      transaction(db, () => add(db, "innermost"));
      throw new Error("inner fails");
    }), /inner fails/);
    add(db, "after");
  });
  assert.deepEqual(values(db), ["before", "after"]);
});

test("an outer throw rolls back the savepoints that were already released into it", () => {
  const db = room();
  assert.throws(() => transaction(db, () => {
    add(db, "outer");
    transaction(db, () => add(db, "inner"));
    throw new Error("outer fails");
  }), /outer fails/);
  assert.deepEqual(values(db), []);
  assert.equal(db.isTransaction, false);
});

test("a block that returns a promise is refused and rolled back", async () => {
  const db = room();
  let later = false;
  assert.throws(() => transaction(db, (async () => {
    add(db, "before the await");
    await null;
    later = true;
    throw new Error("an async block's own rejection is not left unhandled");
  }) as never), /a transaction cannot await/);
  assert.deepEqual(values(db), []);
  assert.equal(db.isTransaction, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(later, true, "the async remainder ran outside, and its rejection was absorbed");
});

test("a failure that already ended the transaction is rethrown, not masked by the rollback", () => {
  const db = room();
  db.exec("CREATE TRIGGER t_stop BEFORE INSERT ON t WHEN NEW.v = 'stop' BEGIN SELECT RAISE(ROLLBACK, 'stopped'); END");
  assert.throws(() => transaction(db, () => { add(db, "a"); transaction(db, () => add(db, "stop")); }), /stopped/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(values(db), []);
});
