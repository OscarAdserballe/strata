import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Conflict, checkIfMatch, ifMatchOf } from "./if-match.ts";

const req = (ifMatch?: string | string[]): IncomingMessage =>
  ({ headers: ifMatch === undefined ? {} : { "if-match": ifMatch } }) as unknown as IncomingMessage;

test("a revision is a quoted tag or a bare number; no header and * state none", () => {
  assert.equal(ifMatchOf(req()), null);
  assert.equal(ifMatchOf(req("*")), null);
  assert.equal(ifMatchOf(req('"12"')), 12);
  assert.equal(ifMatchOf(req("12")), 12);
  assert.equal(ifMatchOf(req(' "0" ')), 0, "surrounding space is the header's, not the tag's");
});

test("anything else is the caller's bug: a 400 that says what was sent", () => {
  for (const bad of ['W/"12"', '"12", "13"', "twelve", '"-1"', '"1.5"', "", '""', '"12']) {
    assert.throws(() => ifMatchOf(req(bad)), (e: Error & { httpStatus?: number }) => e.httpStatus === 400 && /If-Match/.test(e.message), bad);
  }
});

test("a stale base throws the conflict with the value asked for only then; a fresh one or none passes", () => {
  let asked = 0;
  const value = () => { asked++; return { text: "theirs" }; };
  checkIfMatch(req('"7"'), 7, value);
  checkIfMatch(req(), 7, value);
  checkIfMatch(req("*"), 7, value);
  assert.equal(asked, 0, "a matching write builds nothing extra");
  assert.throws(() => checkIfMatch(req('"6"'), 7, value), (e: unknown) => {
    assert.ok(e instanceof Conflict);
    assert.deepEqual(e.body, { error: "changed elsewhere", conflict: { rev: 7, value: { text: "theirs" } } });
    return true;
  });
  assert.equal(asked, 1);
});
