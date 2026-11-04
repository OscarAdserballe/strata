import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CRAM, EVERYWHERE, KEEPS, REVIEW, ROOM, SHEETS, type KeyGroup } from "./sheets.ts";
import { ROUTES, SURFACES } from "../../surfaces.ts";

const heard: { capture?: (e: KeyboardEvent) => void; bubble?: (e: KeyboardEvent) => void } = {};
(globalThis as { window?: unknown }).window = {
  addEventListener: (_: string, fn: (e: KeyboardEvent) => void, cap?: boolean) => { if (cap) heard.capture = fn; else heard.bubble = fn; },
};
const reg = await import("./registry.ts");

function documented(groups: readonly KeyGroup[]): Set<string> {
  const out = new Set<string>();
  const name: Record<string, string> = { space: " ", "⇧space": " ", "↵": "enter", esc: "escape",
    "↓": "arrowdown", "↑": "arrowup", "←": "arrowleft", "→": "arrowright" };
  for (const [, rows] of [...groups, ...EVERYWHERE]) for (const [keys] of rows) {
    if (keys.length === 1) { out.add(name[keys] ?? keys); continue; }
    for (let part of keys.split(/\s*\/\s*|\s+/)) {
      if (!part) continue;
      const range = /^(\d)–(\d)$/.exec(part);
      if (range) { for (let d = +range[1]; d <= +range[2]; d++) out.add(String(d)); continue; }
      part = part.replace(/^[\^⌘⇧]+/, "");
      out.add(name[part] ?? part.toLowerCase());
    }
  }
  return out;
}
function bound(file: string, from?: RegExp): Set<string> {
  let src = readFileSync(file, "utf8");
  if (from) src = src.slice(src.search(from));
  const out = new Set<string>();
  for (const m of src.matchAll(/\b(?:k|e\.key)\s*===\s*"([^"]+)"/g)) {
    const k = m[1].toLowerCase();
    out.add({ _: "-", "+": "=" }[k] ?? k);
  }
  return out;
}
const HANDLERS: [string, readonly KeyGroup[], string, RegExp?][] = [
  ["room", ROOM, "web/capabilities/keys/room-keys.ts"],
  ["review", REVIEW, "web/surfaces/review/ReviewSurface.tsx", /const onKey = /],
  ["cram", CRAM, "web/surfaces/cram/CramSurface.tsx", /const onKey = /],
  ["keeps", KEEPS, "web/surfaces/keeps/KeepsSurface.tsx", /const onKey = /],
];

test("every key a screen binds is in its ? sheet (c was missing once)", () => {
  for (const [screen, sheet, file, from] of HANDLERS) {
    const docs = documented(sheet);
    const missing = [...bound(file, from)].filter((k) => !docs.has(k));
    assert.deepEqual(missing, [], `${screen}: bound in ${file} but not in sheets.ts`);
  }
  assert.ok(documented(ROOM).has("c"), "c makes a card of the last answer");
});

test("every screen registers its key layout with the registry, and nothing else listens for them", () => {
  assert.match(readFileSync("web/capabilities/keys/room-keys.ts", "utf8"), /registerKeys\(\{ screen: "board"/, "the room (library, board, reader) registers");
  assert.match(readFileSync("web/shell/BoardRoute.tsx", "utf8"), /useRoomKeys\(\{/, "the board route registers the room's layout");
  for (const [screen, sheet] of HANDLERS) assert.equal(SHEETS[screen === "room" ? "board" : screen], sheet, `${screen}'s page of the sheet`);
  for (const [screen, , file] of HANDLERS.slice(1)) {
    const src = readFileSync(file, "utf8");
    assert.match(src, new RegExp(`registerKeys\\(\\{ screen: "${screen}"`), `${screen} registers its layout`);
    assert.doesNotMatch(src, /window\.addEventListener\("keydown"/, `${screen} does not listen on its own`);
  }
  for (const r of ROUTES) assert.ok(["library", "board", "reader", "review", "cram", "keeps"].includes(SURFACES[r].keys));
});

const key = (k: string, target: unknown = null) => {
  const e = { key: k, target, shiftKey: false, metaKey: false, ctrlKey: false, cancelBubble: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } };
  return e as unknown as KeyboardEvent & { cancelBubble: boolean };
};
const press = (k: string, target?: unknown) => {
  const e = key(k, target);
  heard.capture?.(e);
  if (!e.cancelBubble) heard.bubble?.(e);
  return e;
};

test("the dispatch order: the sheet, then the screens laid over the room, then the room", () => {
  const got: string[] = [];
  const offRoom = reg.registerKeys({ screen: "board", onKey: (e) => { got.push("room:" + e.key); if (e.key === "?") reg.openKeysSheet(); } });
  press("j");
  assert.deepEqual(got.splice(0), ["room:j"]);
  press("?");
  assert.equal(reg.keysSheetOpen(), true);
  press("j");
  assert.equal(reg.keysSheetOpen(), false);
  assert.deepEqual(got.splice(0), ["room:?"]);

  const offReview = reg.registerKeys({ screen: "review", over: true, owns: true,
    onKey: (e) => { got.push("review:" + e.key); e.stopPropagation(); } });
  press("h");
  assert.deepEqual(got.splice(0), ["review:h"]);
  press("?");
  assert.equal(reg.keysSheetOpen(), true);
  assert.deepEqual(got.splice(0), [], "neither the review nor the room heard ?");
  const shown = reg.sheetNow(SHEETS, EVERYWHERE).groups.map(([t]) => t);
  assert.deepEqual(shown, ["the review", "everywhere"], "an owning screen's sheet is its own");
  press("Escape");
  assert.equal(reg.keysSheetOpen(), false, "esc closes the top layer: the sheet");
  assert.deepEqual(got.splice(0), [], "…and only the sheet");
  press("?", { tagName: "TEXTAREA" });
  assert.equal(reg.keysSheetOpen(), false);
  got.splice(0);
  offReview();

  const offKeeps = reg.registerKeys({ screen: "keeps", over: true,
    onKey: (e) => { got.push("keeps:" + e.key); if (e.key === "s") e.stopPropagation(); } });
  press("s"); press("r");
  assert.deepEqual(got.splice(0), ["keeps:s", "keeps:r", "room:r"]);
  assert.deepEqual(reg.sheetNow(SHEETS, EVERYWHERE).groups.map(([t]) => t).slice(0, 2), ["the keeps", ROOM[0][0]], "the keeps' sheet, then the room's");
  offKeeps(); offRoom();
  assert.equal(reg.layoutsNow().length, 0);
});

test("the sheet fills the room's placeholders when it opens", () => {
  const off = reg.registerKeys({ screen: "board", onKey: () => {}, info: () => ({ fill: { ui: "110", pz: "90" }, foot: "this page costs 3k" }) });
  const { groups, foot } = reg.sheetNow(SHEETS, EVERYWHERE);
  const text = JSON.stringify(groups);
  assert.match(text, /now 110%/); assert.match(text, /now 90%/);
  assert.doesNotMatch(text, /\{(ui|pz)\}/);
  assert.equal(foot, "this page costs 3k");
  off();
});

test("closeTopLayer closes the highest open layer of the stack, and says when none was open", () => {
  const open = new Set(["veil", "bench-lib", "ask-dock"]);
  const closed: string[] = [];
  const closer = (name: string) => ({ open: () => open.has(name), close: () => { open.delete(name); closed.push(name); } });
  const off = reg.registerLadder(() => ({ veil: closer("veil"), "ask-dock": closer("ask-dock"), "bench-lib": closer("bench-lib") }));
  const offEmpty = reg.registerLadder(() => undefined);
  assert.equal(reg.closeTopLayer(), true);
  assert.equal(reg.closeTopLayer(), true);
  assert.equal(reg.closeTopLayer(), true);
  assert.deepEqual(closed, ["ask-dock", "bench-lib", "veil"], "the thread, then the keeps, then the library");
  assert.equal(reg.closeTopLayer(), false, "nothing open: nothing closed");
  off(); offEmpty();
  open.add("veil");
  assert.equal(reg.closeTopLayer(), false, "an unregistered stack is not asked");
});
