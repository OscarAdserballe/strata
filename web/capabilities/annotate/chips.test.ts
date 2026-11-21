import { test } from "node:test";
import assert from "node:assert/strict";
import { chipKey, isMarkKey, type ChipOffer } from "./chips.ts";

const all: ChipOffer = { note: true, ask: true, card: true, remove: false };
const notesOnly: ChipOffer = { note: true, ask: false, card: false, remove: false };

test("M marks the picked words, in either case, but not with a modifier", () => {
  assert.equal(isMarkKey({ key: "m" }), true);
  assert.equal(isMarkKey({ key: "M" }), true);
  assert.equal(isMarkKey({ key: "m", metaKey: true }), false);
  assert.equal(isMarkKey({ key: "n" }), false);
});

test("N, A and C pick their chip", () => {
  assert.deepEqual(chipKey({ key: "n" }, all), { act: "note", prefill: "" });
  assert.deepEqual(chipKey({ key: "a" }, all), { act: "ask", prefill: "" });
  assert.deepEqual(chipKey({ key: "C" }, all), { act: "card", prefill: "" });
});

test("any other letter starts the note with it, case kept", () => {
  assert.deepEqual(chipKey({ key: "T" }, all), { act: "note", prefill: "T" });
  assert.deepEqual(chipKey({ key: "é" }, all), { act: "note", prefill: "é" });
});

test("where only notes are offered, A and C are letters of the note", () => {
  assert.deepEqual(chipKey({ key: "a" }, notesOnly), { act: "note", prefill: "a" });
  assert.deepEqual(chipKey({ key: "c" }, notesOnly), { act: "note", prefill: "c" });
});

test("Esc drops the chips and stops there; other keys drop them and carry on", () => {
  assert.deepEqual(chipKey({ key: "Escape" }, all), { drop: true, pass: false });
  assert.deepEqual(chipKey({ key: "z", metaKey: true }, all), { drop: true, pass: true });
  assert.deepEqual(chipKey({ key: "ArrowDown" }, all), { drop: true, pass: true });
  assert.deepEqual(chipKey({ key: "1" }, all), { drop: true, pass: true });
  assert.deepEqual(chipKey({ key: " " }, all), { drop: true, pass: true });
});

test("a modifier pressed alone leaves the chips up, so a capital still reaches the note", () => {
  assert.equal(chipKey({ key: "Shift" }, all), null);
  assert.equal(chipKey({ key: "CapsLock" }, all), null);
});
