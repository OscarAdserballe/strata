import { test } from "node:test";
import assert from "node:assert/strict";

test("a read with its own signal keeps the reads kept warm; a write drops them", async (t) => {
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  });
  // imported after the mock: the module reads navigator at load (each test file is its own process)
  const { api, prefetch } = await import("./api.ts");
  await prefetch("/api/decks/d1");
  await api("/api/imports", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  await api("/api/decks/d1");
  assert.deepEqual(asked.filter((a) => a.endsWith("/api/decks/d1")), ["GET /api/decks/d1"], "the click took the deck read ahead");
  await prefetch("/api/decks/d2");
  await api("/api/boards/b1/resources/r1", { method: "PATCH", body: "{}" });
  await api("/api/decks/d2");
  assert.equal(asked.filter((a) => a.endsWith("/api/decks/d2")).length, 2, "a write in between: asked again");
});
