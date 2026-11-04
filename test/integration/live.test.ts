// Live model tests: run only with STRATA_LIVE_TESTS=1 and a GEMINI_API_KEY (or GEMINI_API_KEY_FILE).
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer, type TestServer } from "../support/server.ts";
import { MD } from "./seed.ts";

const asked = process.env.STRATA_LIVE_TESTS === "1";
const server = asked ? useServer({ live: true }) : ({ live: false } as TestServer);
const api = (path: string, init?: RequestInit) => server.api(path, init);
const why = asked ? "no GEMINI_API_KEY (or GEMINI_API_KEY_FILE)" : "live model tests: set STRATA_LIVE_TESTS=1 and GEMINI_API_KEY or GEMINI_API_KEY_FILE";

const BOOK = {
  one: [
    "# Chapter One — Cartels\n\nA cartel exists to solve one problem: **price competition drives price to marginal cost**. Members agree to restrict output so the market price rises toward the monopoly price.\n\nThe binding constraint on a cartel is DETECTION LAG. If a defection takes k periods to notice, the punishment arrives δ^k smaller, and the cartel is exactly as stable as a more impatient one would be.",
    "The cartel's stability condition is that the present value of colluding beats one round of defection. The critical discount factor for the symmetric Cournot case is δ* = (n-1)/(2n-1), which rises with the number of firms — more members, harder to sustain.",
  ],
  two: [
    "# Chapter Two — Advertising\n\nAdvertising solves a different problem: **consumers do not know the product exists**. The binding constraint here is not detection but WEAROUT — the marginal persuasive effect of the nth exposure falls, and past a point additional spend is pure waste.",
    "The Dorfman–Steiner condition sets the optimal advertising-to-sales ratio equal to the ratio of the advertising elasticity to the absolute price elasticity: A/pQ = η_A / |η_p|. Note that this says nothing about detection lag or discount factors; those belong to a different mechanism entirely.",
  ],
};

const liveBook = async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "live — where am I" }) });
  const id = made.board.id;
  const pages = [...BOOK.one, ...BOOK.two];
  const { body: res } = await api(`/api/boards/${id}/resources`, {
    method: "POST",
    body: JSON.stringify({
      filename: "industrial-organisation.pdf", kind: "pdf", text: pages.join("\n\n"),
      sections: [
        { label: "Chapter One — Cartels", firstPage: 1, lastPage: 2 },
        { label: "Chapter Two — Advertising", firstPage: 3, lastPage: 4 },
      ],
      pageText: pages,
    }),
  });
  const { body: state } = await api(`/api/boards/${id}`);
  const secs = state.sections.filter((s: { resourceId: string }) => s.resourceId === res.id)
    .sort((a: { ord: number }, b: { ord: number }) => a.ord - b.ord);
  return { id, secs };
};

const liveAsk = async (id: string, message: string, here: Record<string, unknown>) => {
  const { status, body } = await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message, here }) });
  assert.equal(status, 200);
  const reply = body.state.messages.at(-1).text as string;
  console.log(`\n  ── asked (${JSON.stringify(here)}):\n     "${message}"\n  ── replied:\n${reply.split("\n").map((l: string) => "     " + l).join("\n")}\n`);
  return reply;
};

test("LIVE: the same question in two chapters gets two different answers", async (t) => {
  if (!server.live) return t.skip(why);
  const { id, secs } = await liveBook();
  const q = "What is the binding constraint here, and why?";

  const inOne = await liveAsk(id, q, { sectionId: secs[0].id, page: 1 });
  const inTwo = await liveAsk(id, q, { sectionId: secs[1].id, page: 3 });

  assert.match(inOne, /detection/i, "chapter one's constraint is detection lag");
  assert.doesNotMatch(inOne, /wearout|dorfman/i, "chapter two was not in the window");
  assert.match(inTwo, /wearout|exposure/i, "chapter two's constraint is wearout");
  assert.doesNotMatch(inTwo, /detection lag/i, "chapter one was not in the window");

  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("LIVE: it knows it cannot see the rest of the book, and says so", async (t) => {
  if (!server.live) return t.skip(why);
  const { id, secs } = await liveBook();
  const reply = await liveAsk(id, "What does the Dorfman–Steiner condition say?", { sectionId: secs[0].id, page: 1 });
  // it may answer from general knowledge, but must not claim to be reading it here
  assert.doesNotMatch(reply, /as (?:the|this) (?:chapter|section|page) (?:says|states|puts it)/i);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("LIVE: a card gets answered, turned over or not", async (t) => {
  if (!server.live) return t.skip(why);
  const { id, secs } = await liveBook();
  const card = { prompt: "What is the critical discount factor for a symmetric Cournot cartel?", revealed: false };

  const given = await liveAsk(id, "I'm stuck on this one — help me", { sectionId: secs[0].id, page: 2, card });
  assert.match(given, /2n\s*-\s*1|discount factor/i, "it answers the card directly");
  assert.doesNotMatch(given, /what do you think|try (?:to )?answer|can you recall/i, "no quiz-back");

  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("LIVE: a real streamed turn answers from the source", async (t) => {
  if (!server.live) return t.skip(why);
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ question: "live turn check" }) });
  const id = made.board.id;
  const b64 = Buffer.from(MD, "utf-8").toString("base64");
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "tuckman-ch4.md", base64: b64 }) });
  const { body: state } = await api(`/api/boards/${id}`);
  const sec = state.sections.find((s: { resourceId: string }) => s.resourceId === res.id);
  const { status, body } = await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "In one sentence: what is the failure mode named in the source?", here: { sectionId: sec.id } }) });
  assert.equal(status, 200);
  const reply = body.state.messages.at(-1).text.toLowerCase();
  assert.ok(reply.includes("convexity"), `reply should ground in the source, got: ${reply.slice(0, 200)}`);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

// With nothing open the turn has no source; the model must say so rather than invent one.
test("LIVE: on home, with nothing open, it says so instead of inventing a source", async (t) => {
  if (!server.live) return t.skip(why);
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ question: "empty-handed check" }) });
  const id = made.board.id;
  const b64 = Buffer.from(MD, "utf-8").toString("base64");
  await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "tuckman-ch4.md", base64: b64 }) });
  const reply = await liveAsk(id, "In one sentence: what is the failure mode named in the source?", { onHome: true });
  assert.doesNotMatch(reply, /byzantine/i, "the old failure: a source it never saw, invented confidently");
  assert.match(reply, /open|don't have|do not have|can't see|cannot see|not been given|no source/i,
    "it has to say it is not looking at anything");
  await api(`/api/boards/${id}`, { method: "DELETE" });
});
