import { test } from "node:test";
import assert from "node:assert/strict";
import { withBridge } from "./live.ts";

test("the bridge goes in before the page's last </body>, never inside a script that writes one", () => {
  const page = `<html><body><script>frame.srcdoc = "<body>" + inner + "</body></html>";</script><p>end</p></body></html>`;
  const out = withBridge(page);
  const script = page.slice(page.indexOf("<script>"), page.indexOf("</script>") + 9);
  assert.ok(out.includes(script), "the page's own script is left whole");
  assert.ok(out.endsWith("</script></body></html>"), "the bridge sits just before the real end of the body");
  assert.equal(out.indexOf("<p>end</p>") < out.lastIndexOf("strata-live"), true);
});

test("a page with no body gets the bridge at its end", () => {
  assert.ok(withBridge("<p>bare</p>").startsWith("<p>bare</p><script>"));
});
