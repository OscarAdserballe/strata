import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

async function seedDividedWithDecks(title: string) {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title }) });
  const id = made.board.id;
  const pg = (s: string) => s.repeat(30);
  const { body: res } = await api(`/api/boards/${id}/resources`, {
    method: "POST",
    body: JSON.stringify({
      filename: "two-chapters.pdf", kind: "pdf", text: pg("ALPHA. ") + pg("BETA. "),
      sections: [
        { label: "Chapter One", firstPage: 1, lastPage: 1 },
        { label: "Chapter Two", firstPage: 2, lastPage: 2 },
      ],
      pageText: [pg("ALPHA. "), pg("BETA. ")],
    }),
  });
  assert.equal(res.sections, 2);
  const { body: state } = await api(`/api/boards/${id}`);
  const secs = state.sections.filter((s: { resourceId: string }) => s.resourceId === res.id)
    .sort((a: { ord: number }, b: { ord: number }) => a.ord - b.ord);
  const tree = (label: string) => ({
    title: label, question: "?",
    nodes: [{ label: "root claim", kind: "concept", anchor: "p. 1", children: [
      { label: "a child", kind: "claim", anchor: "p. 1", children: [
        { label: "a grandchild", kind: "claim", anchor: "p. 1" },
      ] },
    ] }],
  });
  const fc = (node: string, i: number) => ({ node, type: "flashcard", source: "p. 1", front: `q${i} of ${node}?`, back: "a." });
  await api(`/api/boards/${id}/resources/${res.id}/tree?section=${secs[0].id}`, {
    method: "PUT", body: JSON.stringify({ tree: tree("one"), cards: [fc("n1", 1), fc("n1.1", 2), fc("n1.1.1", 3)] }),
  });
  await api(`/api/boards/${id}/resources/${res.id}/tree?section=${secs[1].id}`, {
    method: "PUT", body: JSON.stringify({ tree: tree("two"), cards: [fc("n1", 1), fc("n1.1", 2)] }),
  });
  const slugs = secs.map((s: { id: string }) => "src-" + s.id.replace(/[^a-z0-9]/gi, "").toLowerCase());
  return { id, rid: res.id as string, slugs };
}

test("pairs: a board is a course — each page couples one source to one deck", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "Advanced IO" }) });
  const id = made.board.id;
  assert.deepEqual(made.state.pairs, []);

  const b64 = Buffer.from("# Lecture 4\n\nCollusion.\n", "utf-8").toString("base64");
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "lecture4.md", base64: b64 }) });
  const { status, body: p1 } = await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "4 · Collusion", resourceId: res.id, deck: "aio-lecture-4" }) });
  assert.equal(status, 201);
  assert.equal(p1.state.pairs.length, 1);
  assert.equal(p1.state.pairs[0].label, "4 · Collusion");
  assert.equal(p1.state.pairs[0].resourceId, res.id);
  assert.equal(p1.state.pairs[0].deck, "aio-lecture-4");

  const { body: p2 } = await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "scratch", deck: "aio-lecture-5" }) });
  assert.equal(p2.state.pairs.length, 2);
  assert.equal(p2.state.pairs[1].resourceId, null);
  assert.deepEqual(p2.state.pairs.map((x: { ord: number }) => x.ord), [0, 1]);

  const { body: patched } = await api(`/api/boards/${id}/pairs/${p2.id}`, { method: "PATCH", body: JSON.stringify({ deck: "aio-lecture-6" }) });
  assert.equal(patched.state.pairs[1].deck, "aio-lecture-6");

  await api(`/api/boards/${id}/resources/${res.id}`, { method: "DELETE" });
  const { body: afterDel } = await api(`/api/boards/${id}`);
  assert.equal(afterDel.pairs.length, 2);
  assert.equal(afterDel.pairs[0].resourceId, null);

  await api(`/api/boards/${id}/pairs/${p1.id}`, { method: "DELETE" });
  const { body: afterPairDel } = await api(`/api/boards/${id}`);
  assert.equal(afterPairDel.pairs.length, 1);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("deleting a source with ?pairs=1 takes its pairs and their decks too", async () => {
  const { id, rid, slugs } = await seedDividedWithDecks("book delete");
  const { body: before } = await api(`/api/boards/${id}`);
  assert.equal(before.pairs.length, 2, "a divided source arrives with one pair per chapter");
  const del = await api(`/api/boards/${id}/resources/${rid}?pairs=1`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.state.resources, []);
  assert.deepEqual(del.body.state.pairs, [], "the pages went with the source");
  const { body: decks } = await api("/api/decks");
  for (const slug of slugs) assert.ok(!decks.decks.some((d: { slug: string }) => d.slug === slug), "the generated decks went too");
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("deleting a deck-only pair with ?deck=1 spares a deck another pair still uses", async () => {
  const mk = async (title: string) => {
    const { body } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title }) });
    const { body: p } = await api(`/api/boards/${body.board.id}/pairs`, { method: "POST", body: JSON.stringify({ label: "drill", deck: "csharp-async" }) });
    return { id: body.board.id as string, pid: p.id as string };
  };
  const a = await mk("door one");
  const b = await mk("door two");
  const cardsOf = async () => (await api("/api/decks/csharp-async")).body.cards?.length ?? 0;
  const full = await cardsOf();
  assert.ok(full > 0, "the fixture course has cards");
  // the deck survives: another pair still uses it
  await api(`/api/boards/${a.id}/pairs/${a.pid}?deck=1`, { method: "DELETE" });
  assert.equal(await cardsOf(), full);
  // the last pair goes: the cards go with it
  await api(`/api/boards/${b.id}/pairs/${b.pid}?deck=1`, { method: "DELETE" });
  const gone = await api("/api/decks/csharp-async");
  assert.ok(gone.status === 404 || (gone.body.cards ?? []).length === 0, "the deck went with its last pair");
  await api(`/api/boards/${a.id}`, { method: "DELETE" });
  await api(`/api/boards/${b.id}`, { method: "DELETE" });
});
