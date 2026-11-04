// Lazy chunks must share nothing with main.js, or esbuild hoists the shared module into a boot chunk.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const LAZY = {
  "web/capabilities/sources/Capture.tsx": ["web/shell/atoms.tsx"],
  "web/capabilities/sources/ImportPlan.tsx": ["shared/imports/import-plan.ts", "shared/imports/budget.ts"],
  "web/surfaces/review/SessionMap.tsx": [],
  "web/surfaces/keeps/KeepsSurface.tsx": [],
  "web/surfaces/cram/CramSurface.tsx": ["web/surfaces/cram/cram.ts"],
  "web/capabilities/keys/sheets.ts": [],
  "node_modules/katex/dist/katex.mjs": [],
  "node_modules/pdfjs-dist/build/pdf.mjs": [],
  // a pasted screenshot's shrinking, fetched by the first paste (capabilities/attach/attach.ts)
  "web/engines/image/shrink.ts": [],
  // the Desk's agent-token panel (surfaces/library/ConnectAgent.tsx)
  "web/surfaces/library/ConnectPanel.tsx": [],
};

const { metafile } = await esbuild.build({
  entryPoints: ["web/main.tsx"], bundle: true, outdir: "dist", format: "esm", splitting: true,
  chunkNames: "chunks/[name]-[hash]", jsx: "automatic", write: false, metafile: true, logLevel: "silent",
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, assetNames: "[name]",
});
const outputs = Object.entries(metafile.outputs).filter(([path]) => path.endsWith(".js"));
const main = metafile.outputs["dist/main.js"];
const carried = (o) => Object.entries(o.inputs).filter(([, i]) => i.bytesInOutput > 0).map(([path]) => path);

test("each lazy door is its own chunk, reached from main.js by import() only", () => {
  for (const [entry, alone] of Object.entries(LAZY)) {
    const found = outputs.find(([, o]) => o.entryPoint === entry);
    assert.ok(found, `${entry} has a chunk of its own`);
    const [path, chunk] = found;
    assert.ok(main.imports.some((i) => i.path === path && i.kind === "dynamic-import"), `main.js reaches ${entry} by import()`);
    assert.ok(!main.imports.some((i) => i.path === path && i.kind === "import-statement"), `main.js never loads ${entry} at boot`);
    for (const input of alone) {
      assert.ok(carried(chunk).includes(input), `${input} rides in ${entry}'s chunk`);
      assert.ok(!carried(main).includes(input), `${input} is not in main.js`);
    }
  }
});

test("main.js and the lazy chunks share no module: the only chunk loaded at boot is esbuild's runtime", () => {
  // chunks shared only between lazy chunks never load at boot, so only main.js's static imports count
  const shared = outputs.filter(([, o]) => !o.entryPoint);
  const boot = shared.filter(([p]) => main.imports.some((i) => i.path === p && i.kind === "import-statement"));
  for (const [path, o] of boot) {
    assert.deepEqual(carried(o), [], `${path} carries modules every boot would load: a lazy chunk imports something main.js imports`);
    assert.ok(o.bytes < 2048, `${path} is ${o.bytes} B: more than esbuild's helpers`);
  }
  for (const [path, o] of outputs) {
    for (const i of o.imports.filter((i) => i.kind === "import-statement" && !i.external)) {
      assert.ok(shared.some(([p]) => p === i.path), `${path} statically imports ${i.path}, which is not a shared chunk`);
    }
  }
});
