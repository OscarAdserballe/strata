import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stopServer } from "../support/stop-server.ts";
import { freePort } from "../support/free-port.ts";
import { tmpdir } from "node:os";

test("a password-protected instance works under its own path", async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/sharing`;
  const data = mkdtempSync(join(tmpdir(), "strata-base-test-"));
  const server = spawn(process.execPath, ["server/main.ts"], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: {
      ...process.env,
      STRATA_PORT: String(port),
      STRATA_DATA: data,
      STRATA_BASE_PATH: "/sharing",
      STRATA_PASSWORD: "test-password",
      STRATA_ORIGIN: "",
      STRATA_LEGACY_ORIGINS: "",
      STRATA_LEGACY_BASE_PATHS: "/friend",
      STRATA_TRUSTED_PROXY_IPS: "",
      GEMINI_API_KEY: "",
    },
    stdio: "ignore",
  });
  t.after(async () => { await stopServer(server); rmSync(data, { recursive: true, force: true }); });

  let ready = false;
  for (const end = Date.now() + 60_000; !ready && Date.now() < end;) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(ready, "server should start");

  const gate = await fetch(`${base}/`);
  assert.equal(gate.status, 401);
  const gateHtml = await gate.text();
  assert.match(gateHtml, /\/sharing\/api\/login/);
  const csp = gate.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce && gateHtml.includes(`script nonce="${nonce}"`), "the login bootstrap carries this response's CSP nonce");
  assert.equal(gate.headers.get("x-content-type-options"), "nosniff");

  const formerPath = await fetch(`http://127.0.0.1:${port}/friend/?board=b-123&open=card-4`, { redirect: "manual" });
  assert.equal(formerPath.status, 308);
  assert.equal(formerPath.headers.get("location"), `${base}/?board=b-123&open=card-4`);

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /st_auth_sharing=/);
  assert.match(setCookie, /Path=\/sharing\//);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(";", 1)[0];

  const page = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /STRATA_BASE = "\/sharing\/"/);
  assert.equal((await fetch(`${base}/dist/main.js`, { headers: { Cookie: cookie } })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/boards`, { headers: { Cookie: cookie } })).json(), { boards: [] });

  assert.equal((await fetch(`${base}/server/platform/security/auth.ts`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${base}/.env`, { headers: { Cookie: cookie } })).status, 404);

  const crossed = await fetch(`${base}/api/boards`, {
    method: "POST", headers: { Cookie: cookie, Origin: "http://other.example.test", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "must not land" }),
  });
  assert.equal(crossed.status, 403);
  const same = await fetch(`${base}/api/boards`, {
    method: "POST", headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "same origin" }),
  });
  assert.equal(same.status, 201);

  const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);

  let ninth: Response | null = null;
  for (let i = 0; i < 9; i++) ninth = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${i + 1}` },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(ninth?.status, 429);
});

test("an explicitly named legacy origin keeps old sharing links alive", async (t) => {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), "strata-origin-test-"));
  const server = spawn(process.execPath, ["server/main.ts"], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: {
      ...process.env, STRATA_PORT: String(port), STRATA_DATA: data, STRATA_BASE_PATH: "/sharing",
      STRATA_PASSWORD: "test-password", STRATA_ORIGIN: "https://sharing.example.test",
      STRATA_LEGACY_ORIGINS: "http://strata.example.test", GEMINI_API_KEY: "",
      STRATA_TRUSTED_PROXY_IPS: "127.0.0.1", STRATA_SESSION_DAYS: "7",
    },
    stdio: "ignore",
  });
  t.after(async () => { await stopServer(server); rmSync(data, { recursive: true, force: true }); });
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/sharing/api/health`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const old = await fetch(`http://127.0.0.1:${port}/sharing/?board=b-123&open=card-4`, {
    headers: { "X-Forwarded-Host": "strata.example.test", "X-Forwarded-Proto": "http" }, redirect: "manual",
  });
  assert.equal(old.status, 308);
  assert.equal(old.headers.get("location"), "https://sharing.example.test/sharing/?board=b-123&open=card-4");
  // A proxy that strips the mount prefix sends `/`; the redirect must still name the room's own address.
  const stripped = await fetch(`http://127.0.0.1:${port}/?board=b-123`, {
    headers: { "X-Forwarded-Host": "strata.example.test", "X-Forwarded-Proto": "http" }, redirect: "manual",
  });
  assert.equal(stripped.status, 308);
  assert.equal(stripped.headers.get("location"), "https://sharing.example.test/sharing/?board=b-123");
  const strippedApi = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { "X-Forwarded-Host": "strata.example.test", "X-Forwarded-Proto": "http" }, redirect: "manual",
  });
  assert.equal(strippedApi.headers.get("location"), "https://sharing.example.test/sharing/api/health");

  const login = await fetch(`http://127.0.0.1:${port}/sharing/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie") ?? "";
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /Max-Age=604800/);
});

test("changing the password revokes cookies minted with the old one", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "strata-revoke-test-"));
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => { await Promise.all(children.map(stopServer)); rmSync(data, { recursive: true, force: true }); });
  const start = async (port: number, password: string) => {
    const child = spawn(process.execPath, ["server/main.ts"], {
      cwd: join(import.meta.dirname, "..", ".."),
      env: { ...process.env, STRATA_PORT: String(port), STRATA_DATA: data, STRATA_PASSWORD: password, GEMINI_API_KEY: "", STRATA_ORIGIN: "" },
      stdio: "ignore",
    });
    children.push(child);
    for (const end = Date.now() + 60_000; Date.now() < end;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server on ${port} did not start`);
  };
  const first = await freePort(), second = await freePort();
  await start(first, "first-password");
  const login = await fetch(`http://127.0.0.1:${first}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "first-password" }),
  });
  const oldCookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
  assert.ok(oldCookie);

  await start(second, "second-password");
  assert.equal((await fetch(`http://127.0.0.1:${second}/api/boards`, { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${second}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "second-password" }),
  })).status, 200);
});
