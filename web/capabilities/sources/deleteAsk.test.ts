import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteAsk } from "./deleteAsk.ts";

test("the delete confirm says what goes and what stays", () => {
  assert.equal(deleteAsk({}), "delete this source?");
  assert.equal(deleteAsk({ notes: 1 }), "delete it and its 1 note?");
  assert.equal(deleteAsk({ kept: 3 }), "delete this source? (3 kept cards stay in Review)");
  assert.equal(deleteAsk({ notes: 2, kept: 1 }), "delete it and its 2 notes? (1 kept card stays in Review)");
});
