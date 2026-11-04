import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlTwin, rendersAsPage } from "./html-twin.ts";

test("the twin keeps headings and prose, and drops code, styles and controls", () => {
  const html = `<!DOCTYPE html><html><head><title>T</title><style>p{}</style></head><body>
    <nav>Home</nav><h2>Odds &amp; ends</h2><p>Posterior odds =<br>prior&nbsp;odds × LR.</p>
    <script>if (a < b) document.write("<p>no</p>")</script><svg><text>axis</text></svg>
    <button>Run</button><table><tr><td>a</td><td>b</td></tr></table><!-- gone --></body></html>`;
  assert.equal(htmlTwin(html), "# T\n\nHome\n\n## Odds & ends\n\nPosterior odds =\n\nprior odds × LR.\n\na b");
});

test("a page with its own code, drawing or styles shows as a page; bare markup is an article", () => {
  assert.ok(rendersAsPage("<p>x</p><script></script>"));
  assert.ok(rendersAsPage("<canvas></canvas>"));
  assert.ok(rendersAsPage("<head><style>body{font:16px Inter}</style></head><p>x</p>"));
  assert.ok(rendersAsPage('<link href="https://fonts.example/a.css" rel="stylesheet"><p>x</p>'));
  assert.ok(!rendersAsPage('<link rel="icon" href="x.png"><p>x</p>'));
  assert.ok(!rendersAsPage('<p style="color:red">An LMS page</p>'));
  assert.ok(!rendersAsPage("<article><p>Just words.</p></article>"));
});
