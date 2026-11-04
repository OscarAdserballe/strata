import { test } from "node:test";
import assert from "node:assert/strict";
import { StrataReason, StrataWhy, StrataMB } from "./api.ts";

const err = (message: string, status?: number): Error & { status?: number } =>
  Object.assign(new Error(message), status === undefined ? {} : { status });

test("the server's own words are the reason, whenever it gave any", () => {
  assert.equal(
    StrataReason(err("that is bigger than this server takes — a file may be up to 48 MB", 413)),
    "that is bigger than this server takes — a file may be up to 48 MB",
  );
  assert.equal(StrataWhy(err("a source needs a name", 400), "couldn't rename that"),
    "couldn't rename that — a source needs a name");
});

test("a bare status is turned into something a person can act on", () => {
  // api() falls back to `HTTP <n>` when the body carried no error string
  assert.match(StrataReason(err("HTTP 401", 401)), /signed out/);
  assert.match(StrataReason(err("HTTP 404", 404)), /isn't on this server/);
  assert.match(StrataReason(err("HTTP 503", 503)), /no model key/);
  assert.equal(StrataReason(err("HTTP 500", 500)), "the server said 500");
});

test("offline is named as offline — and read-only, which is the part that explains it", () => {
  // refuseWrite's error: status 0, thrown before fetch was ever reached
  assert.match(StrataReason(err("offline — read only", 0)), /offline, and offline is read-only/);
});

test("a fetch that never got a status says the server didn't answer, not the browser's dialect", () => {
  // no status at all = fetch itself threw; the message differs per browser
  assert.equal(StrataReason(err("Failed to fetch")), "the server didn't answer");   // chrome
  assert.equal(StrataReason(err("Load failed")), "the server didn't answer");       // safari
  // …but a real message from somewhere that isn't the wire is kept verbatim
  assert.equal(StrataReason(err("couldn't be read off the disk (NotReadableError)")),
    "couldn't be read off the disk (NotReadableError)");
  assert.equal(StrataReason(undefined), "no reason given");
});

test("sizes are said the way the person holding the file says them", () => {
  assert.equal(StrataMB(24737072), "24 MB");
  assert.equal(StrataMB(48 * 1024 * 1024), "48 MB");
  assert.equal(StrataMB(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(StrataMB(8000), "8 kB");
});
