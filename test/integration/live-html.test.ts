import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

const PAGE = `<!doctype html><html><head><title>Base rates</title><script>window.x = 1</script></head>
<body><h1>Base rates</h1><p>A rare illness makes most positives false.</p><input type="range"></body></html>`;

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("an interactive page is kept live, read as its text, and served only inside a sandbox", async () => {
  const id = await newBoard(server, { question: "Why do base rates matter?" });
  try {
    const { status, body } = await api(`/api/boards/${id}/resources`, { method: "POST",
      body: JSON.stringify({ filename: "base-rates.html", base64: Buffer.from(PAGE).toString("base64") }) });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.state.resources[0].kind, "html");

    const raw = await (await fetch(`${server.base}/api/boards/${id}/resources/${body.id}/raw`)).text();
    assert.equal(raw, "# Base rates\n\nA rare illness makes most positives false.");

    const live = await fetch(`${server.base}/api/boards/${id}/resources/${body.id}/live`);
    assert.equal(live.status, 200);
    const csp = live.headers.get("content-security-policy") ?? "";
    assert.match(csp, /^sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(live.headers.get("x-frame-options"), null);
    const html = await live.text();
    assert.ok(html.startsWith(PAGE.slice(0, PAGE.indexOf("</body>"))), "the page itself, unchanged");
    assert.match(html, /strata-live[\s\S]*<\/script><\/body>/, "with the bridge just before </body>");
  } finally { await api(`/api/boards/${id}`, { method: "DELETE" }); }
});

test("a static page reads as an article: its words, no markup, no /live route", async () => {
  const id = await newBoard(server, { question: "Static pages" });
  try {
    const { body } = await api(`/api/boards/${id}/resources`, { method: "POST",
      body: JSON.stringify({ filename: "essay.html", base64: Buffer.from("<html><body><p>Just words.</p></body></html>").toString("base64") }) });
    assert.equal(body.state.resources[0].kind, "text");
    assert.equal(await (await fetch(`${server.base}/api/boards/${id}/resources/${body.id}/raw`)).text(), "Just words.");
    assert.equal((await fetch(`${server.base}/api/boards/${id}/resources/${body.id}/live`)).status, 404);
  } finally { await api(`/api/boards/${id}`, { method: "DELETE" }); }
});

test("a page styled only with CSS shows as itself, not stripped to its words", async () => {
  const id = await newBoard(server, { question: "Styled pages" });
  const page = `<!doctype html><html><head><style>body{font:16px Inter;color:#123}</style></head><body><h1>Design</h1><p>No scripts here.</p></body></html>`;
  try {
    const { body } = await api(`/api/boards/${id}/resources`, { method: "POST",
      body: JSON.stringify({ filename: "styled.html", base64: Buffer.from(page).toString("base64") }) });
    assert.equal(body.state.resources[0].kind, "html");
    const live = await fetch(`${server.base}/api/boards/${id}/resources/${body.id}/live`);
    assert.equal(live.status, 200);
    assert.match(await live.text(), /<style>body\{font:16px Inter;color:#123\}<\/style>/);
  } finally { await api(`/api/boards/${id}`, { method: "DELETE" }); }
});
