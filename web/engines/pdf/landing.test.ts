import { test } from "node:test";
import assert from "node:assert/strict";
import { pageTop } from "./landing.ts";

const box = (offsetTop: number, lead: { offsetTop: number; clm: boolean } | null) => ({
  offsetTop,
  previousElementSibling: lead && { offsetTop: lead.offsetTop, classList: { contains: (c: string) => lead.clm && c === "clm" } },
}) as unknown as HTMLElement;

test("a page begins at its claim band when one stands over it, two pixels above, never below zero", () => {
  assert.equal(pageTop(box(900, null)), 898);
  assert.equal(pageTop(box(900, { offsetTop: 860, clm: true })), 858);
  assert.equal(pageTop(box(900, { offsetTop: 10, clm: false })), 898);   // the previous page is not a lead-in
  assert.equal(pageTop(box(1, null)), 0);
});
