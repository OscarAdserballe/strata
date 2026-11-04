// Reads back each formula's KaTeX annotation to check it reached KaTeX whole.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server.browser";
      export { mdBlocks } from "./blocks.tsx"; export { MathText, loadMath } from "./math.tsx"; export { tex } from "./text.ts";`,
    resolveDir: import.meta.dirname, loader: "js",
  },
  bundle: true, write: false, format: "esm", logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
});
const R = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
await R.loadMath();

const chat = (s: string): string => R.renderToStaticMarkup(R.mdBlocks(s));
const card = (s: string): string => R.renderToStaticMarkup(R.createElement(R.MathText, { text: R.tex(s) }));
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const drawn = (html: string) => [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map((m) => unescape(m[1]));

const FORMULAS = [
  "x_1", "a_i b_j", "\\hat{\\beta}_{PC} - 10\\hat{\\beta}_{ACT}", "\\text{Var}(\\hat\\beta_\\text{PC})", "A_{ij} B_{jk}",
  "a^* b^*", "x * y * z", "\\{a, b\\}", "|x| + |y|", "a \\mid b", "a < b > c", "a \\& b", "\\#S", "[0, 1]",
  "a\\_b", "\\$5", "a \\\\ b", "x'' + y'", "\\frac{1}{2}", "\\sum_{i=1}^n x_i", "\\left( \\frac{a}{b} \\right)",
  "\\mathbb{E}[X]", "\\lVert x \\rVert_2", "\\mathbf{x}^\\top \\mathbf{y}", "e^{i\\pi} = -1",
  "0.05", "-3.5", "p = 0.561", "t = 0.0707/0.1212",
];
const CONTEXTS: [string, (f: string) => string][] = [
  ["prose", (f) => `See $${f}$ here.`],
  ["bold", (f) => `**bold $${f}$ text**`],
  ["italic", (f) => `*it $${f}$ text*`],
  ["list", (f) => `- item $${f}$\n- next`],
  ["ordered list", (f) => `1. step $${f}$\n2. next`],
  ["nested list", (f) => `- outer\n  - inner $${f}$`],
  ["task list", (f) => `- [ ] do $${f}$`],
  ["quote", (f) => `> quoted $${f}$`],
  ["heading", (f) => `## Head $${f}$`],
  ["table", (f) => `| a | b |\n|---|---|\n| $${f}$ | x |`],
  ["link text", (f) => `[see $${f}$](https://example.com)`],
  ["footnote", (f) => `Claim[^1].\n\n[^1]: note $${f}$`],
  ["after code", (f) => "`code` and $" + f + "$"],
  ["hard break", (f) => `line one  \n$${f}$ two`],
  ["money first", (f) => `pay $5, $10 or $20 for $${f}$`],
  ["display", (f) => `Then\n\n$$${f}$$\n\nafter`],
  ["display in a line", (f) => `so $$${f}$$ inline`],
  ["display in a list", (f) => `- step\n\n  $$${f}$$`],
  ["\\( \\)", (f) => `See \\(${f}\\) here.`],
  ["\\( \\) spaced", (f) => `See \\( ${f} \\) here.`],
  ["\\[ \\]", (f) => `See\n\n\\[${f}\\]\n\nafter`],
];

test("every formula reaches KaTeX whole, in every context, through both renderers", () => {
  for (const [name, render] of [["chat", chat], ["card", card]] as const) {
    for (const f of FORMULAS) for (const [where, wrap] of CONTEXTS) {
      const html = render(wrap(f));
      assert.deepEqual(drawn(html), [f], `${name} · ${where} · ${f}`);
      assert.doesNotMatch(html, /[]/, `${name} · ${where} · ${f}: a maths slot leaked`);
    }
  }
});

test("money is prose, and maths in code or an address is just characters", () => {
  for (const s of ["$50 for the $100 plan", "pay $5, $10 or $20", "from $5-$10", "costs \\$5 and \\$6"]) {
    assert.deepEqual(drawn(chat(s)), [], s);
    assert.deepEqual(drawn(card(s)), [], s);
  }
  assert.match(chat("run `echo $a_1 $b$` now"), /<code>echo \$a_1 \$b\$<\/code>/);
  assert.match(chat("```\n$x_1$ and $y$\n```"), /<code>\$x_1\$ and \$y\$<\/code>/);
  assert.match(chat("[a](https://example.com/$x_1$)"), /href="https:\/\/example.com\/\$x_1\$"/);
  assert.match(chat("![pic $x_1$](https://example.com/a.png)"), /alt="pic \$x_1\$"/);
});
