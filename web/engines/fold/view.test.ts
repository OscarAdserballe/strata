import { test } from "node:test";
import assert from "node:assert/strict";
import { draftItem, type FoldDraft, type FoldIntents } from "./view.ts";

// A draft's sheet needs only elements that hold children, values and listeners; they are stubbed here.
class Node_ {
  className = ""; textContent = ""; value = ""; placeholder = ""; type = ""; rows = 0; disabled = false;
  kids: Node_[] = [];
  heard: Record<string, ((e: unknown) => void)[]> = {};
  onclick: (() => void) | null = null;
  doc: FakeDoc;
  constructor(doc: FakeDoc) { this.doc = doc; }
  append(...xs: Node_[]) { this.kids.push(...xs); }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.heard[t] ??= []).push(fn); }
  contains(n: unknown): boolean { return n === this || this.kids.some((k) => k.contains(n)); }
  focus() { this.doc.activeElement = this; }
  click() { if (!this.disabled) this.onclick?.(); }
  all(): Node_[] { return [this, ...this.kids.flatMap((k) => k.all())]; }
  find(cls: string): Node_ | undefined { return this.all().find((n) => n.className.split(" ").includes(cls)); }
}
class FakeDoc {
  activeElement: unknown = null;
  createElement() { return new Node_(this); }
}

function draw(it: Partial<FoldDraft>) {
  const said: string[] = [];
  const on = {
    format: (_id: string, f: string, b: string) => said.push(`format ${f}|${b}`),
    keep: (_id: string, f: string, b: string) => said.push(`keep ${f}|${b}`),
    discard: () => said.push("discard"),
  } as unknown as FoldIntents;
  const box = draftItem(new FakeDoc() as unknown as Document, { kind: "draft", id: "draft", quote: "some words", ...it }, on) as unknown as Node_;
  return { box, said, button: () => box.find("fi-pri")!, front: box.find("fi-front")!, back: box.find("fi-back")! };
}

test("a fresh draft offers Format, never Keep: its first press asks for the tidy", () => {
  const d = draw({});
  assert.equal(d.button().textContent, "Format");
  assert.equal(d.box.find("fi-keep"), undefined);
  d.front.value = " What is spaced repetition? "; d.back.value = "Reviews spread over time.";
  d.button().click();
  assert.deepEqual(d.said, ["format What is spaced repetition?|Reviews spread over time."]);
});

test("while it is being tidied, nothing can be pressed or typed", () => {
  const d = draw({ phase: "formatting", front: "q", back: "a" });
  assert.equal(d.button().textContent, "Formatting…");
  assert.ok(d.button().disabled && d.front.disabled && d.back.disabled);
  d.button().click();
  assert.deepEqual(d.said, []);
});

test("once tidied, it shows the tidied faces shaded, and Keep saves what they hold", () => {
  const d = draw({ phase: "formatted", front: "What is $x^2$?", back: "A square." });
  assert.match(d.box.className, /\btidied\b/);
  assert.equal(d.button().textContent, "Keep");
  assert.equal(d.front.value, "What is $x^2$?");
  assert.ok(!d.front.disabled, "the tidied faces stay editable");
  assert.equal(d.box.all().some((n) => /edit again/i.test(n.textContent)), false, "there is no way back but discard");
  d.back.value = "A square, tweaked.";
  d.button().click();
  assert.deepEqual(d.said, ["keep What is $x^2$?|A square, tweaked."]);
  d.box.find("fi-drop")!.click();
  assert.deepEqual(d.said.at(-1), "discard");
});

test("a failed Format puts your words back with why, and offers Format again", () => {
  const d = draw({ phase: "writing", front: "q", back: "a", error: "Couldn't format this card." });
  assert.equal(d.button().textContent, "Format");
  assert.equal(d.front.value, "q");
  assert.equal(d.box.find("fi-err")?.textContent, "Couldn't format this card.");
});

test("⌘↵ formats first, then keeps", () => {
  const press = (box: Node_) => box.heard.keydown.forEach((fn) => fn({ key: "Enter", metaKey: true, ctrlKey: false, preventDefault() {}, stopPropagation() {} }));
  const fresh = draw({});
  fresh.front.value = "q";
  press(fresh.box);
  assert.deepEqual(fresh.said, ["format q|"]);
  const tidied = draw({ phase: "formatted", front: "q", back: "a" });
  press(tidied.box);
  assert.deepEqual(tidied.said, ["keep q|a"]);
});
