import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { htmlProblems } from "./check-html.ts";

const ok = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

test("a page that would open passes", () => {
  assert.deepEqual(htmlProblems(ok("<h1>Pick B</h1>")), []);
  assert.deepEqual(htmlProblems(ok("<canvas id=c></canvas><script>const c = document.getElementById('c'); /* <b> */</script>"), { remoteOnly: true }), []);
  assert.deepEqual(htmlProblems(ok('<script type="module">import x from "https://cdn.jsdelivr.net/npm/x@1/+esm";</script><script type="application/json">{"a":</script>')), [], "modules and data blocks aren't parsed");
  assert.deepEqual(htmlProblems(ok('<p>x</p><script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>'), { remoteOnly: true }), []);
  assert.deepEqual(htmlProblems(ok('<p>x</p><script src="app.js"></script>')), [], "an upload may keep its own paths");
});

test("each way a page opens blank is named", () => {
  assert.match(htmlProblems(ok('<div id="root"></div>')).join(), /shows nothing/);
  assert.match(htmlProblems(ok("<p>x</p><script>\nlet a = 1;\nreturn (</script>")).join(), /^script 1, line 3: /);
  assert.match(htmlProblems(ok("<p>x</p><script>const a = <App/>;</script>")).join(), /Unexpected token '<'/);
  assert.match(htmlProblems(ok('<p>x</p><script type="text/babel">x</script>')).join(), /compile it/);
  assert.match(htmlProblems(ok('<p>x</p><script src="./app.js"></script>'), { remoteOnly: true }).join(), /https CDN/);
  assert.match(htmlProblems("<html><body><p>x</p><script>let a").join(), /never closed.*no <\/body>/);
});

test("a dashboard page must be a whole document with real content", () => {
  const page = { remoteOnly: true, document: true };
  assert.match(htmlProblems("PLACEHOLDER", page).join(), /isn't an HTML document.*placeholder/);
  assert.match(htmlProblems("<h1>Pick B</h1>", page).join(), /isn't an HTML document/);
  for (const stub of ["PLACEHOLDER", "TODO", "  tbd. ", "Lorem ipsum dolor sit amet", "…"]) assert.match(htmlProblems(ok(`<p>${stub}</p>`), page).join(), /placeholder/, stub);
  assert.deepEqual(htmlProblems(ok("<h1>Placeholder images are gone</h1>"), page), []);
  assert.deepEqual(htmlProblems(ok("<canvas></canvas><p>TODO</p>"), page), [], "a drawing carries the page");
  assert.deepEqual(htmlProblems("PLACEHOLDER"), [], "an upload may be a text fragment");
});

test("the pages the routine is shown as examples pass", () => {
  const dir = new URL("../../../tools/dispatch-pages/", import.meta.url);
  for (const f of readdirSync(dir)) assert.deepEqual(htmlProblems(readFileSync(new URL(f, dir), "utf-8"), { remoteOnly: true }), [], f);
});
