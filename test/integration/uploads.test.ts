// This server runs with a 1 MB cap, so going over it is cheap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const cap = 1024 * 1024;
const server = useServer({ env: { STRATA_MAX_UPLOAD: String(cap), STRATA_MIN_SECTION_WORDS: undefined } });

test("a body over the cap is answered with 413 and the file limit in words", async () => {
  const base = server.base;

  const health = await (await fetch(base + "/api/health")).json();
  assert.equal(health.maxUpload, cap);

  const { id: bid } = (await (await fetch(base + "/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "the shelf" }) })).json()).board;
  const big = JSON.stringify({ filename: "huge.pdf", base64: "A".repeat(7 * 1024 * 1024) });
  const r = await fetch(`${base}/api/boards/${bid}/resources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  assert.equal(r.status, 413, "a status, not a severed connection");
  const said = (await r.json()).error as string;
  assert.match(said, /1(\.0)? MB/, "it names the FILE cap, which is the number a person can act on");

  assert.equal((await fetch(base + "/api/health")).status, 200);

  const bad = await fetch(`${base}/api/boards/${bid}/resources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error as string, /valid JSON/);
});
