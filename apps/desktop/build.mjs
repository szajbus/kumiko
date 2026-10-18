// Bundles the Electron main process together with the server, so the packaged app needs no node_modules.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("out", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile: "out/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // ws optionally loads these native speedups; without them it uses plain JS.
  external: ["electron", "bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
await copyFile("src/preload.cjs", "out/preload.cjs");
console.log("bundled out/main.js");
