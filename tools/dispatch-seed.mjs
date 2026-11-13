#!/usr/bin/env node
// node tools/dispatch-seed.mjs [http://127.0.0.1:8804]: fills a room's dashboard for Dispatch with synthetic threads, through its own routes and tools.
const BASE = (process.argv[2] ?? "http://127.0.0.1:8804").replace(/\/$/, "");
let k = 0, rpc = 0, token = "";
const key = () => `seed-${Date.now().toString(36)}-${++k}`;

async function api(path, method = "GET", body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": key() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(out)}`);
  return out;
}
async function tool(name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return res.content[0].text;
}

// ---------- pages: plain synthetic HTML, the way Claude would post them ----------
const STYLE = `<style>
body{margin:0;background:#fbfaf7;color:#22211f;font:16px/1.6 Georgia,"Times New Roman",serif}
main{max-width:760px;margin:44px auto 80px;padding:0 24px}
h1{font-size:31px;line-height:1.15;margin:0 0 16px} h3{font-size:19px;margin:0 0 10px}
p.lede{font-size:17px;color:#45433f;margin:0 0 20px}
.box{border:1px solid #e3e0da;border-radius:10px;background:#fff;padding:16px 19px;margin:0 0 18px}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.col{border:1px solid #e3e0da;border-radius:8px;padding:10px 11px}
.col small{display:block;font:11px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#77736b;margin-bottom:6px}
.step{font:13px/1.2 system-ui,sans-serif;border:1px solid #e9e6df;border-radius:5px;padding:5px 8px;margin:5px 0;background:#fdfcfa}
.step.bad{border:1px dashed #d9826b;color:#b4533b;text-align:center;background:#fdf3ef}
.step.new{border-color:#e6b69f}
.code{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 18px}
pre{margin:0;background:#2a2622;color:#e8e2d8;border-radius:8px;padding:12px 13px;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap}
pre .c{color:#9a9184} pre mark{background:#f6e6a8;color:#2a2622}
.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;border-top:1px solid #e3e0da;padding-top:13px;font:14px/1.4 system-ui,sans-serif}
.facts small{display:block;font:10px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#77736b}
.res{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 18px}
.res .box{margin:0} .red{color:#b4533b} .green{color:#3d7a52}
</style>`;
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${STYLE}</head><body><main>${body}</main></body></html>`;

const decideV1 = page("v1", `<h1>Recipe steps added by the assistant never get a photo</h1>
<p class="lede">The assistant copies the photo from the step before. I would rather it asked you which photo to use.</p>
<div class="box"><h3>Option A · Copy the previous photo</h3><p>Quick, and often wrong when two steps look nothing alike.</p></div>
<div class="facts"><div><small>Size</small>1 PR · about 120 lines</div><div><small>Touches</small>Step editor</div><div><small>Proof</small>One new test</div><div><small>Unsure about</small>Whether anyone notices</div></div>`);

const decideV2 = page("v2", `<h1>Recipe steps added by the assistant never get a photo</h1>
<p class="lede">I'd make the assistant name a photo for every step it saves, and refuse an edit that leaves one out.</p>
<div class="box"><h3>What happens today</h3><div class="cols">
 <div class="col"><small>1 · Recorded</small><div class="step">whisk the eggs 📷</div><div class="step">rest 10 minutes (timer only)</div><div class="step">fold in flour 📷</div></div>
 <div class="col"><small>2 · Assistant's draft</small><div class="step">step_1 📷</div><div class="step new">step_2 · new step</div><div class="step">step_3 📷</div></div>
 <div class="col"><small>3 · Recipe page</small><div class="step">Step 1 📷</div><div class="step bad">Step 2 · no photo</div><div class="step">Step 3 📷</div></div>
</div></div>
<div class="code"><pre><span class="c">// today</span>
save_recipe({ recipe })
photos = filter(old, ids)</pre><pre><span class="c">// proposed</span>
steps: [{ id, action, photo: 12 }]
no photo → <mark>E_STEP_PHOTO_MISSING</mark></pre></div>
<div class="cols" style="margin:0 0 18px">
 <div class="box" style="margin:0"><h3>A · Assistant picks a photo</h3><p>The photo lives in the recipe page, not in the saved steps. What I'd do.</p></div>
 <div class="box" style="margin:0"><h3>B · Copy the previous</h3><p>You turned this down in v1.</p></div>
 <div class="box" style="margin:0"><h3>C · Server matches it</h3><p>A guess by timestamp.</p></div>
</div>
<div class="facts"><div><small>Size</small>1 PR · about 370 lines</div><div><small>Touches</small>Recipe tool input, prompt</div><div><small>Proof</small>Test red first · eval grader</div><div><small>Unsure about</small>The sample recipe is made up</div></div>`);

const shortDecide = (h, lede, a, b) => page("v1", `<h1>${h}</h1><p class="lede">${lede}</p>
<div class="cols" style="grid-template-columns:1fr 1fr;margin:0 0 18px"><div class="box" style="margin:0"><h3>A</h3><p>${a}</p></div><div class="box" style="margin:0"><h3>B</h3><p>${b}</p></div></div>
<div class="facts"><div><small>Size</small>1 PR</div><div><small>Touches</small>One screen</div><div><small>Proof</small>A browser check</div><div><small>Unsure about</small>Nothing yet</div></div>`);

const reviewPage = (h, added, left) => page("built", `<h1>${h}</h1>
<div class="res"><div class="box"><h3 class="red">✗ Red on main</h3><p>The new test fails: no refusal for a step without a photo.</p></div>
<div class="box"><h3 class="green">✓ Green on the PR</h3><p>Same test, and 74 around it. The new eval grader passes.</p></div>
<div class="box"><h3 class="green">✓ Live eval</h3><p>Pass rate unchanged. About 0.3 more model calls a recipe.</p></div></div>
<div class="box"><h3>Added beyond the plan</h3><ol>${added.map((x) => `<li>${x}</li>`).join("")}</ol></div>
<div class="box"><h3>Left out</h3><p>${left}</p></div>
<div class="facts"><div><small>Size</small>+709 −45 · 17 files</div><div><small>PR</small>#3724 (made up)</div><div><small>CI</small>green</div><div><small>Merge</small>squash</div></div>`);

// ---------- the board ----------
async function thread(title, body, links = []) {
  const id = `t_seed${Math.random().toString(36).slice(2, 12)}`;
  await api("/api/dashboard/tasks", "POST", { id, title, body, links, area: "work", stage: "backlog" });
  return id;
}
const send = (id) => api(`/api/dashboard/tasks/${id}/send`, "POST", {});
const press = (id, kind) => api(`/api/dashboard/tasks/${id}/press`, "POST", { kind });
const post = (id, args) => tool("dashboard_post", { key: key(), id, ...args });
async function version(id, n) { const p = await api("/api/dashboard/dispatch"); return { board: p.board, rid: p.threads.find((t) => t.id === id).versions.find((v) => v.n === n).resourceId }; }
async function note(id, n, quote, text) {
  const { board, rid } = await version(id, n);
  return (await api(`/api/boards/${board}/marks`, "POST", { resourceId: rid, quote, start: 0, end: quote.length, note: text })).id;
}

const had = await api("/api/dashboard/dispatch");
if (had.threads.length) { console.log(`· ${BASE} already has ${had.threads.length} Dispatch threads; nothing seeded`); process.exit(0); }
token = (await api("/api/agent/tokens", "POST", { name: "dispatch seed", write: true })).token;

// Inbox · 3, counting what the demo seed already put there
const room = 3 - had.inbox;
for (const it of [
  { title: "Saved timers vanish when a second one starts", context: "Starting a new timer made the previous one disappear (a race of some kind?)", from: { source: "Linear · RCP-118" } },
  { title: "Why does importing a cookbook take so long?", context: "Work out why a 40-recipe import takes minutes.", from: { source: "Linear · RCP-117" } },
  { title: "The shopping list is hard to read", context: "People went straight for the photos; the quantities were too faint to see.", from: { source: "Slack · #product" } },
].slice(0, Math.max(0, room))) await api("/api/dashboard/inbox", "POST", it);

// Backlog · 4
await thread("Units switch back to cups after a reload", "The metric setting doesn't survive a reload. Find where it is dropped.", [{ kind: "linear", ref: "RCP-109" }]);
await thread("Design the sharing path for family cookbooks", "Who can edit a shared cookbook, and how is that asked?");
await thread("Drop the per-step oven presets", "One oven setting per recipe is enough. Remove the per-step ones.", [{ kind: "linear", ref: "RCP-096" }]);
await thread("Show the timer counting down in the recipe view", "Make the running timer visible beside the step.", [{ kind: "linear", ref: "RCP-101" }]);

// Implementing · 5: three building (after Go), two preparing a page
const b1 = await thread("Grocery export misses fractional amounts", "Halves and quarters come out as 0 in the export.", [{ kind: "linear", ref: "RCP-090" }]);
await send(b1); await post(b1, { page: shortDecide("Fractions become 0 in the grocery export", "The export rounds before it formats.", "Format first, round last.", "Keep fractions as text.") }); await press(b1, "go");
const b2 = await thread("Search ignores accents", "Searching for creme should find crème.", [{ kind: "linear", ref: "RCP-087" }]);
await send(b2); await post(b2, { page: shortDecide("Search ignores accents", "Fold accents when indexing and when searching.", "Fold both sides.", "A second index.") }); await press(b2, "go");
const b3 = await thread("Nutrition panel overlaps on narrow phones", "The panel sits on top of the steps below 360px.", [{ kind: "linear", ref: "RCP-084" }]);
await send(b3); await post(b3, { page: shortDecide("The nutrition panel overlaps", "Let it wrap under the title on narrow screens.", "Wrap.", "Collapse it.") }); await press(b3, "go");
await post(b3, { page: reviewPage("Built: the panel wraps under the title.", ["The title no longer clips at 320px."], "A collapsed panel, which you didn't pick.") });
await press(b3, "back");
const p1 = await thread("Bump the image pipeline to Node 24", "Move the image workers to Node 24 and check the thumbnails.");
await send(p1);
const p2 = await thread("Show a typed step being read aloud", "Prove read-aloud works on the staging site with a recording.", [{ kind: "linear", ref: "RCP-080" }]);
await send(p2); await post(p2, { page: shortDecide("Read-aloud on staging", "A recording of each step read aloud.", "Record in the browser.", "Record on a phone.") });
await note(p2, 1, "Record in the browser", "Use a phone, the browser one sounds tinny.");
await press(p2, "back");

// Review · 2: one built straight from v1, then the one with three versions, which sits on top
const r2 = await thread("Shopping list forgets checked items", "Ticked items come back after closing the list.", [{ kind: "linear", ref: "RCP-073" }]);
await send(r2); await post(r2, { page: shortDecide("Ticked items come back", "Ticks are kept in memory only.", "Save each tick.", "Save on close.") }); await press(r2, "go");
await post(r2, { page: reviewPage("Built: every tick is saved as you make it.", ["Unticking is saved too."], "Syncing ticks between phones.") });

const r1 = await thread("Recipe pages print with a blank second page", "Printing a short recipe adds an empty page.", [{ kind: "linear", ref: "RCP-077" }, { kind: "github", ref: "PR #3724" }]);
await send(r1);
await post(r1, { page: shortDecide("Short recipes print a blank page", "The footer forces a page break.", "Drop the forced break.", "Shrink the footer.") });
await note(r1, 1, "Shrink the footer", "Not this one.");
await press(r1, "back");
await post(r1, { page: shortDecide("Short recipes print a blank page (v2)", "Only break before the footer when the recipe is longer than a page.", "Measure, then break.", "Never break.") });
await note(r1, 2, "Measure, then break", "Yes, this.");
await note(r1, 2, "Never break", "Long recipes would run into the footer.");
await press(r1, "go");
await post(r1, { page: reviewPage("Built as you picked in v2. Two things were added.", ["A recipe with a photo on its last step keeps the photo on that page.", "A step named <code>__proto__</code> prints like any other."], "Photos stay in the separate gallery, not on the step itself.") });
await note(r1, 3, "Photos stay in the separate gallery", "File an issue to put photos on the steps. Not in this PR.");
// Decide · 4: the one with two versions is created last, so it sits on top
for (const [title, body, h, lede, a, b, links] of [
  ["Saved timers vanish during import", "Find why timers disappear while a cookbook imports.", "Timers vanish during import", "The import resets the timer store.", "Keep timers outside the import.", "Pause timers while importing.", [{ kind: "linear", ref: "RCP-071" }]],
  ["Recipe overview is hard to scan", "People skip the overview and go straight to step one.", "The overview is hard to scan", "Lead with time, servings and the oven.", "A summary row.", "A card per step.", []],
  ["Drop per-step configurable timers", "Most recipes need one timer per step at most.", "Per-step timer settings", "Fold them into one setting per recipe.", "One setting.", "Keep both.", [{ kind: "linear", ref: "RCP-066" }]],
]) {
  const id = await thread(title, body, links);
  await send(id); await post(id, { page: shortDecide(h, lede, a, b) });
  if (title.startsWith("Recipe overview")) await note(id, 1, "A summary row", "Show a sketch of the row first.");
}
const d1 = await thread("Some recipe steps lack photos", "Steps the assistant adds have no photo. Find why and fix it so every step shows one. Synthetic recipes only.", [{ kind: "linear", ref: "RCP-128" }]);
await send(d1);
await post(d1, { page: decideV1 });
await note(d1, 1, "Copy the previous photo", "Two steps rarely look the same. Ask instead.");
await press(d1, "back");
await post(d1, { page: decideV2 });
const n1 = await note(d1, 2, "E_STEP_PHOTO_MISSING", "What does the assistant see when this fires?");
await note(d1, 2, "The photo lives in the recipe page, not in the saved steps.", "Good, keep the saved steps small.");
await post(d1, { replies: { [`hl_${n1}`]: "The edit comes back refused with \"choose the photo that shows step_2\". It fixes it in the same turn." } });

const p = await api("/api/dashboard/dispatch");
const count = (s) => p.threads.filter((t) => t.stage === s).length;
console.log(`· seeded ${BASE}: inbox ${p.inbox} · decide ${count("decide")} · implementing ${count("implementing")} · review ${count("review")}`);
console.log(`  → ${BASE}/dispatch`);
