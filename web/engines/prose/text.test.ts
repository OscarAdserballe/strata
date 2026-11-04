import { test } from "node:test";
import assert from "node:assert/strict";
import { texify, unliteralize, tex } from "./text.ts";

test("texify normalises every delimiter form a model reaches for to dollars", () => {
  assert.equal(texify("\\(x\\)"), "$x$");
  assert.equal(texify("\\[x\\]"), "$$x$$");
  assert.match(texify("so \\begin{align}x &= 1\\end{align} holds"), /\$\$\\begin\{align\}/);
});

test("unliteralize fixes escaped newlines outside maths and never inside", () => {
  assert.equal(unliteralize("a\\nb"), "a\nb");
  assert.equal(unliteralize("$\\nabla f$"), "$\\nabla f$");
  assert.equal(unliteralize("cost is $5 and\\nthat is fine"), "cost is $5 and\nthat is fine");
});

test("tex is the pipeline: delimiters first, then newlines", () => {
  assert.equal(tex("\\(\\nu\\) then\\ndone"), "$\\nu$ then\ndone");
});

