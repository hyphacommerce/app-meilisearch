// Bundles the Node host into one file, dist/node.mjs, with every dependency inlined
// (Hypha's SDK included), so the Docker image needs nothing but Node.

import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/hosts/node.ts", import.meta.url).pathname],
  outfile: new URL("../dist/node.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "none",
  // Some CommonJS dependencies `require` Node's built-ins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log("wrote dist/node.mjs");
