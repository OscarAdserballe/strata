import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGateway } from "./gateway.ts";

const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
};

test("one login selects one namespaced room and cannot cross into another", async (t) => {
  const room = (name: string) => createServer((req, res) => {
    if (req.url?.endsWith("/api/health")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); return; }
    let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ name, path: req.url, body })); });
  });
  const a = room("Ben"), b = room("Cy");
  const pa = await listen(a), pb = await listen(b);
  const gateway = createGateway({ sessionSecret: "x".repeat(64), minFreeBytes: 0, accounts: [
    { username: "Ben", password: "first", upstream: `http://127.0.0.1:${pa}`, basePath: "/u/ben" },
    { username: "Cy", password: "second", upstream: `http://127.0.0.1:${pb}`, basePath: "/u/cy" },
  ], host: "127.0.0.1", port: 0 });
  gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
  const port = (gateway.server.address() as { port: number }).port, root = `http://127.0.0.1:${port}`;
  t.after(() => { gateway.server.close(); a.close(); b.close(); });

  const anonymous = await fetch(`${root}/u/ben/api/boards`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const loginHtml = await anonymous.text();
  assert.match(loginHtml, /<p>Login:<\/p>/);
  assert.match(loginHtml, /<button type="submit">enter<\/button>/);
  assert.equal((await fetch(`${root}/api/health`)).status, 200);
  assert.equal((await fetch(`${root}/api/login`, { method: "POST", body: JSON.stringify({ username: "Ben", password: "wrong" }) })).status, 401);
  const login = await fetch(`${root}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "ben", password: "first" }) });
  assert.equal(login.status, 200); assert.equal((await login.json()).path, "/u/ben/");
  const auth = login.headers.get("set-cookie")?.split(";", 1)[0]; assert.ok(auth);
  const own = await fetch(`${root}/u/ben/api/boards`, { headers: { Cookie: auth } });
  assert.deepEqual(await own.json(), { name: "Ben", path: "/u/ben/api/boards", body: "" });
  assert.equal((await fetch(`${root}/u/cy/api/boards`, { headers: { Cookie: auth } })).status, 403);
  const write = await fetch(`${root}/u/ben/api/write`, { method: "PATCH", headers: { Cookie: auth, "Content-Type": "application/json" }, body: '{"kept":true}' });
  assert.deepEqual(await write.json(), { name: "Ben", path: "/u/ben/api/write", body: '{"kept":true}' });
  const logout = await fetch(`${root}/u/ben/api/logout`, { method: "POST", headers: { Cookie: auth } });
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("only a signed admin account can discover and read admin usage", async (t) => {
  let collections = 0;
  const gateway = createGateway({ sessionSecret: "x".repeat(64), accounts: ["Ada", "Cy", "ada2"].map((username) => ({
    username, password: "fixture", upstream: "http://127.0.0.1:1", basePath: `/u/${username.toLowerCase()}/`, admin: username === "Ada",
  })), adminUsage: async () => { collections++; return { at: Date.now(), rooms: [] }; } });
  const root = `http://127.0.0.1:${await listen(gateway.server)}`;
  t.after(() => gateway.server.close());
  const login = async (username: string) => {
    const response = await fetch(`${root}/api/login`, { method: "POST", body: JSON.stringify({ username, password: "fixture" }) });
    return response.headers.get("set-cookie")!.split(";", 1)[0];
  };
  for (const path of ["/api/session", "/admin", "/api/usage"]) {
    assert.equal((await fetch(root+path, { headers: { "x-username": "Ada" } })).status, 401);
  }
  const reader = await login("Cy");
  assert.deepEqual(await (await fetch(root+"/api/session", { headers: { Cookie: reader } })).json(), { username: "Cy", adminPath: null });
  for (const cookie of [reader, await login("ada2")]) {
    for (const path of ["/admin", "/admin/", "/api/usage?username=Ada"]) {
      assert.equal((await fetch(root+path, { headers: { Cookie: cookie, "x-username": "Ada" } })).status, 403);
    }
  }
  const forged = reader.replace(/=([^.]+)\./, (_, payload: string) => {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return "=" + Buffer.from(JSON.stringify({ ...claims, u: "ada" })).toString("base64url") + ".";
  });
  assert.equal((await fetch(root+"/api/usage", { headers: { Cookie: forged } })).status, 401);
  assert.equal(collections, 0);
  const ada = await login("ADA");
  const headers = { Cookie: ada };
  assert.deepEqual(await (await fetch(root+"/api/session", { headers })).json(), { username: "Ada", adminPath: "/admin" });
  const page = await fetch(root+"/admin?period=7", { headers });
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /href="\/u\/ada\/">← My library/);
  assert.equal((await fetch(root+"/api/usage", { headers })).status, 200);
  assert.equal((await fetch(root+"/admin", { headers, method: "POST" })).status, 405);
  assert.equal((await fetch(root+"/admin/private", { headers })).status, 404);
  assert.equal(collections, 2);
});

test("an agent's token or upload link reaches only its own room's agent paths, with no login", async (t) => {
  const room = (name: string) => createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ name, path: req.url, body })); });
  });
  const a = room("Ben"), b = room("Cy");
  const pa = await listen(a), pb = await listen(b);
  const gateway = createGateway({ sessionSecret: "x".repeat(64), minFreeBytes: 0, accounts: [
    { username: "Ben", password: "first", upstream: `http://127.0.0.1:${pa}`, basePath: "/u/ben" },
    { username: "Cy", password: "second", upstream: `http://127.0.0.1:${pb}`, basePath: "/u/cy" },
  ], host: "127.0.0.1", port: 0 });
  gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
  const root = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  t.after(() => { gateway.server.close(); a.close(); b.close(); });
  const bearer = { Authorization: "Bearer stk_abcdefghijklmnopqrstuvwx", "Content-Type": "application/json" };

  const mcp = await fetch(`${root}/u/cy/mcp`, { method: "POST", headers: bearer, body: "{}" });
  assert.deepEqual(await mcp.json(), { name: "Cy", path: "/u/cy/mcp", body: "{}" });
  const upload = await fetch(`${root}/u/ben/api/agent/v1/upload/agent-123456789?exp=1&sig=x`, { method: "PUT", body: "bytes" });
  assert.equal((await upload.json()).name, "Ben");
  assert.equal((await fetch(`${root}/u/ben/mcp`, { method: "POST", body: "{}" })).status, 401, "no token, no login: refused at the gateway");
  for (const [method, path] of [["GET", "/u/ben/api/boards"], ["POST", "/u/ben/api/agent/tokens"], ["GET", "/u/ben/mcp"], ["PUT", "/u/ben/api/imports/x/bytes"]]) {
    assert.equal((await fetch(`${root}${path}`, { method, headers: bearer, ...(method === "GET" ? {} : { body: "{}" }) })).status, 401, `${method} ${path} needs the login`);
  }
});

test("a session in use slides: past a third of its life the cookie is re-minted, and a link from elsewhere still carries it", async (t) => {
  const room = createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "room_pref=1; Path=/" }); res.end(JSON.stringify({ path: req.url })); });
  const port = await listen(room);
  const gateway = createGateway({ sessionSecret: "x".repeat(64), minFreeBytes: 0, sessionDays: 3, accounts: [
    { username: "Ben", password: "first", upstream: `http://127.0.0.1:${port}`, basePath: "/u/ben" },
  ], host: "127.0.0.1", port: 0 });
  const root = `http://127.0.0.1:${await listen(gateway.server)}`;
  t.after(() => { gateway.server.close(); room.close(); });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-17T10:00:00Z") });
  const DAY = 86_400_000;

  const login = await fetch(`${root}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "ben", password: "first" }) });
  const minted = login.headers.get("set-cookie") ?? "";
  assert.match(minted, /Max-Age=259200;/, "three days, as configured");
  assert.match(minted, /SameSite=Lax/, "Lax, so a top-level link from another app opens signed in");
  assert.doesNotMatch(minted, /Secure/, "plain http in the test: no Secure flag");
  const first = minted.split(";", 1)[0];

  // young: nothing to renew, on the gateway's own answers or on a proxied one
  t.mock.timers.tick(DAY * 0.5);
  assert.equal((await fetch(`${root}/api/session`, { headers: { Cookie: first } })).headers.get("set-cookie"), null);
  const proxied = await fetch(`${root}/u/ben/api/boards`, { headers: { Cookie: first } });
  assert.equal(proxied.headers.get("set-cookie"), "room_pref=1; Path=/", "the room's own cookie passes through untouched");

  // past a third of its life: every kind of answer re-mints, and the room's cookie is kept beside the new one
  t.mock.timers.tick(DAY * 0.75);
  const renewedOn = await fetch(`${root}/`, { headers: { Cookie: first }, redirect: "manual" });
  assert.equal(renewedOn.status, 302);
  const second = renewedOn.headers.get("set-cookie") ?? "";
  assert.match(second, /^strata_session=[^;]+; Path=\/; Max-Age=259200; HttpOnly; SameSite=Lax$/);
  assert.notEqual(second.split(";", 1)[0], first);
  const viaRoom = await fetch(`${root}/u/ben/api/boards`, { headers: { Cookie: first } });
  assert.deepEqual(viaRoom.headers.getSetCookie().map((c) => c.split("=")[0]).sort(), ["room_pref", "strata_session"]);
  assert.match((await fetch(`${root}/api/session`, { headers: { Cookie: first } })).headers.get("set-cookie") ?? "", /^strata_session=/);

  // the old cookie dies on its own schedule; the renewed one carries on
  t.mock.timers.tick(DAY * 2);
  assert.equal((await fetch(`${root}/u/ben/api/boards`, { headers: { Cookie: first } })).status, 401);
  assert.equal((await fetch(`${root}/u/ben/api/boards`, { headers: { Cookie: second.split(";", 1)[0] } })).status, 200);

  // Lax changes nothing for writes: a cross-origin POST is still refused by the Origin check
  const crossed = await fetch(`${root}/u/ben/api/boards`, { method: "POST", headers: { Cookie: second.split(";", 1)[0], Origin: "http://other.example.test", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(crossed.status, 403);
});
