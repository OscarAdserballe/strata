import { test } from "node:test";
import assert from "node:assert/strict";
import { pageTop } from "./landing.ts";

const box = (offsetTop: number) => ({ offsetTop }) as unknown as HTMLElement;

test("a page begins two pixels above its top, never below zero", () => {
  assert.equal(pageTop(box(900)), 898);
  assert.equal(pageTop(box(1)), 0);
});
