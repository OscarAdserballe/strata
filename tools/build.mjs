// node tools/build.mjs: bundle the client, lazy chunks, fonts and the offline asset manifest into dist/.

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeSources } from "./dist-fresh.mjs";

// What index.html preloads: the chunk main.js imports before it can run, and the latin files of the faces
// main.tsx warms, so neither waits a round trip behind the bundle.
const WARMED_FACES = [["Spectral", "600"], ["Spectral", "700"], ["IBM Plex Sans", "600"]];
function bootPreload(metafile) {
  const main = metafile.outputs["dist/main.js"];
  const modules = main.imports.filter((i) => i.kind === "import-statement" && !i.external).map((i) => i.path);
  const css = readFileSync("web/vendor/fonts/fonts.css", "utf8");
  const fonts = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1], weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
    const latin = /unicode-range:\s*U\+0000-00FF/.test(block) && /font-style:\s*normal/.test(block);
    const file = /url\(\.\/([^)]+\.woff2)\)/.exec(block)?.[1];
    if (latin && file && WARMED_FACES.some(([f, w]) => f === family && w === weight) && !fonts.includes(`dist/${file}`)) fonts.push(`dist/${file}`);
  }
  writeFileSync("dist/boot-preload.json", JSON.stringify({ modules, fonts }));
}

// pdf.js fetches its image decoders by URL at run time, so they must be in the offline set.
const PDF_WASM = ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"];
function copyPdfWasm() {
  mkdirSync("dist/pdfjs", { recursive: true });
  for (const f of PDF_WASM) copyFileSync(`node_modules/pdfjs-dist/wasm/${f}`, `dist/pdfjs/${f}`);
  return PDF_WASM.map(f => `dist/pdfjs/${f}`);
}

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["web/main.tsx"],
  bundle: true,
  outdir: "dist",
  format: "esm",
  splitting: true,
  metafile: true,
  plugins: [{ name: "offline-assets", setup(build) {
    build.onEnd(result => {
      if (result.errors.length || !result.metafile) return;
      const assets = Object.keys(result.metafile.outputs).filter(path => !path.endsWith(".map"));
      writeFileSync("dist/offline-assets.json", JSON.stringify({ assets: [...assets, ...copyPdfWasm()] }));
      bootPreload(result.metafile);
      writeSources("main", result.metafile);
    });
  } }],
  chunkNames: "chunks/[name]-[hash]",
  target: ["es2022", "safari16"],
  jsx: "automatic",
  minify: true,
  sourcemap: true,
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  assetNames: "[name]",
  logLevel: "info",
};

// runs inside a live HTML source's sandbox, inlined by the server; nothing of the app comes with it
const bridge = { entryPoints: ["web/engines/html/bridge.ts"], bundle: true, outfile: "dist/html-bridge.js", format: "iife",
  target: ["es2020", "safari16"], minify: true, logLevel: "info", metafile: true,
  plugins: [{ name: "sources", setup(build) { build.onEnd((r) => { if (!r.errors.length && r.metafile) writeSources("bridge", r.metafile); }); } }] };

if (watch) {
  const ctx = await esbuild.context(options);
  await (await esbuild.context(bridge)).watch();
  await ctx.watch();
  console.log("[strata] watching web/ → dist/ …");
} else {
  await Promise.all([esbuild.build(options), esbuild.build(bridge)]);
}
