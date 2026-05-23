import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/index.mjs",
  sourcemap: true,
  packages: "external",
});

const publicDir = path.join("dist", "public");
fs.mkdirSync(publicDir, { recursive: true });
fs.copyFileSync("frontend/index.html", path.join(publicDir, "index.html"));
fs.copyFileSync("frontend/hls.min.js", path.join(publicDir, "hls.min.js"));

console.log("Build complete");
fs.copyFileSync("frontend/test.txt", path.join(publicDir, "test.txt"));
