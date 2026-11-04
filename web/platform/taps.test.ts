import { test } from "node:test";
import assert from "node:assert/strict";
import { Interactions, REGIONS, keyName, regionOf } from "./taps.ts";

const JOURNEY = /^[a-z][a-z0-9.]{0,31}$/;   // what server/platform/events/perf.ts accepts

/* a stand-in element: a chain of class lists, innermost first, with closest() over them */
interface Fake { closest(s: string): unknown; getAttribute(n: string): string | null; parentElement: Fake | null }
const el = (...classes: string[]) => {
  const chain = classes.map((c) => ({ c }));
  const at = (i: number): Fake => ({
    closest: (sel: string) => chain.slice(i).some(({ c }) => sel.split(",").some((one) => {
      const want = one.trim().split(".").filter(Boolean);
      const has = c.split(/\s+/);
      return want.every((w) => has.includes(w));
    })) || null,
    getAttribute: (n: string) => (n === "class" && chain[i].c ? chain[i].c : null),
    parentElement: i + 1 < chain.length ? at(i + 1) : null,
  });
  return at(0);
};

test("a tap is named by the part of the room it landed in", () => {
  assert.equal(regionOf(el("bp-btn primary", "bp-row", "bp-front", "desk-at")), "board.front");
  assert.equal(regionOf(el("home-primary", "home-continue", "home-doors", "veil launcher calm-home")), "home.continue");
  assert.equal(regionOf(el("", "q-meta", "rcard", "rwrap", "veil reviewv")), "review.card");
  assert.equal(regionOf(el("", "tlayer", "slide", "pdf-col", "page")), "reader.pdf");
});
test("an unnamed surface is named by its class family, never by what it says", () => {
  assert.equal(regionOf(el("mint-x", "mint wide")), "mint");
  assert.equal(regionOf(el("", "", "wb-row sel")), "wb");
  assert.equal(regionOf(null), "page");
  assert.equal(regionOf(el("")), "page");
});
test("every name the page can send is one the server keeps", () => {
  for (const [, name] of REGIONS) {
    assert.match("tap." + name, JOURNEY);
    assert.match("type." + name, JOURNEY);
  }
  assert.match("tap." + regionOf(el("an-extraordinarily_long-class-name-that-goes-on")), JOURNEY);
  for (const e of [{ key: "n" }, { key: "Escape" }, { key: " " }, { key: "z", metaKey: true }, { key: "ArrowDown", ctrlKey: true }])
    assert.match("key." + keyName(e), JOURNEY);
  assert.equal(keyName({ key: " " }), "space");
  assert.equal(keyName({ key: "z", ctrlKey: true }), "mod.z");
  assert.equal(keyName({ key: "Shift" }), null);
});

/* a fake frame clock: afterPaint callbacks run when frame() is called, timers when tick() is */
function rig() {
  let t = 1000;
  const paints: (() => void)[] = [], timers: { at: number; fn: () => void }[] = [], reports: [string, number][] = [];
  const x = new Interactions((name, ms) => reports.push([name, Math.round(ms)]), (fn) => paints.push(fn), () => t, (fn, ms) => timers.push({ at: t + ms, fn }));
  return {
    x, reports,
    wait: (ms: number) => { t += ms; },
    frame: () => { for (const fn of paints.splice(0)) fn(); },
    tick: (ms: number) => { t += ms; for (const tm of timers.filter((tm) => tm.at <= t)) { timers.splice(timers.indexOf(tm), 1); tm.fn(); } },
    now: () => t,
  };
}

test("a tap counts its worst event, once, after the frame that answers the click", () => {
  const r = rig();
  r.x.on("pointerdown", r.now(), "tap.card");
  r.wait(10); r.frame();                          // the press is answered quickly
  r.wait(80);
  const up = r.now();
  r.x.on("pointerup", up, "tap.card");
  r.x.on("click", up, "tap.card");
  r.wait(240); r.frame();                         // the click's handler kept the thread 240 ms
  assert.deepEqual(r.reports, [["tap.card", 240]]);
  r.tick(2000);
  assert.equal(r.reports.length, 1, "the press timers do not report it again");
});
test("an event that waited for the thread counts the wait", () => {
  const r = rig();
  const pressed = r.now();
  r.wait(150);                                    // the thread was busy when the finger came down
  r.x.on("pointerdown", pressed, "tap.home.review");
  r.x.on("click", pressed, "tap.home.review");
  r.wait(20); r.frame();
  assert.deepEqual(r.reports, [["tap.home.review", 170]]);
});
test("a press that became a scroll is not a wait anyone sat through", () => {
  const r = rig();
  r.x.on("pointerdown", r.now(), "tap.reader.pdf");
  r.x.on("pointercancel", r.now(), "tap.reader.pdf");
  r.wait(16); r.frame(); r.tick(2000);
  assert.deepEqual(r.reports, []);
});
test("a press answered without a click (a drag, a touchend) reports when it settles", () => {
  const r = rig();
  r.x.on("pointerdown", r.now(), "tap.reader.pdf");
  r.wait(16); r.frame();                                // the drag starts; nothing to wait for
  r.wait(400);                                          // the finger is down: that is not a wait
  r.x.on("pointerup", r.now(), "tap.reader.pdf");    // the selection ends; its menu draws
  r.wait(30); r.frame();
  assert.deepEqual(r.reports, [], "not until the press has had its chance to click");
  r.tick(1000);
  assert.deepEqual(r.reports, [["tap.reader.pdf", 30]], "from the release to the menu, not from the press");
});
test("a key is its own interaction, and hiding the tab drops what was open", () => {
  const r = rig();
  r.x.on("keydown", r.now(), "key.n");
  r.wait(33); r.frame();
  r.x.on("keydown", r.now(), "key.escape");
  r.x.hidden();
  r.wait(5000); r.frame();
  assert.deepEqual(r.reports, [["key.n", 33]]);
});
test("a timestamp on another clock is replaced by the moment the listener ran", () => {
  const r = rig();
  r.x.on("keydown", Date.now(), "key.n");           // an epoch timestamp, not page time
  r.wait(12); r.frame();
  assert.deepEqual(r.reports, [["key.n", 12]]);
});
