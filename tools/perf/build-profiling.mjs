// node tools/perf/build-profiling.mjs [outDir]: build with React's profiling renderer, for attribution only
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { REPO } from "./pw.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(HERE, "dist-prof");
const esbuild = await import(pathToFileURL(join(REPO, "node_modules/esbuild/lib/main.js")).href);
const require = createRequire(join(REPO, "package.json"));
const profilingDom = require.resolve("react-dom/profiling");

const reactProfiling = { name: "react-profiling", setup(build) {
  build.onResolve({ filter: /^react-dom$/ }, () => ({ path: profilingDom }));
} };

await esbuild.build({
  absWorkingDir: REPO,
  entryPoints: ["web/main.tsx"],
  bundle: true, outdir: out, format: "esm", splitting: true,
  chunkNames: "chunks/[name]-[hash]", target: ["es2022", "safari16"], jsx: "automatic",
  minifyWhitespace: true, minifySyntax: true, keepNames: true,
  define: { "process.env.NODE_ENV": '"production"' },
  sourcemap: true,
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, assetNames: "[name]",
  plugins: [reactProfiling], logLevel: "info",
});
console.log(`profiling build → ${out}`);
