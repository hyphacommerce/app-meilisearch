// The formatter and linter (Vite+: Oxfmt and Oxlint), configured like Hypha's own
// (`../hypha/vite.config.ts`): `vp fmt`, `vp lint` and `vp check` read only this file.

import { defineConfig } from "vite-plus";

/** Written by tools, checked for staleness by their own commands. */
const generated = ["**/dist/**", "**/node_modules/**", "src/ui/generated/**", ".wrangler/**"];

export default defineConfig({
  fmt: {
    printWidth: 100,
    ignorePatterns: [...generated, "**/*.md", "**/*.toml", "pnpm-lock.yaml"],
  },
  lint: {
    ignorePatterns: generated,
    plugins: ["typescript", "unicorn", "oxc", "import", "promise"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    options: {
      typeAware: true,
    },
    rules: {
      "typescript/consistent-return": "off",
      // Sequential on purpose: paging by cursor, writes that must stay in order.
      "no-await-in-loop": "off",
      "oxc/no-map-spread": "off",
    },
    overrides: [
      {
        // The core and the settings page run on Workers and in browsers: Web APIs only.
        files: ["src/core/**", "src/ui/**"],
        env: { browser: true },
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["node:*"],
                  message: "Web APIs only: the core runs on Workers and Node alike.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/hosts/node.ts", "src/hosts/sqlite.ts", "scripts/**", "test/**"],
        plugins: ["node"],
        env: { node: true },
      },
      {
        files: ["test/**"],
        rules: {
          // `node:test`'s `test()` returns a promise the runner awaits.
          "typescript/no-floating-promises": "off",
          // Fixtures and fakes stand in for API responses whose shape the tests assert.
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
    ],
  },
});
