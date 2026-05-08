#!/usr/bin/env bun
/**
 * Build a standalone defeatbeta-terminal binary.
 *
 * The OpenTUI Solid bindings need a custom Babel JSX plugin to transform
 * `.tsx` source — that plugin is loaded via `bunfig.toml`'s `preload` key
 * during `bun run dev`, but the `bun build --compile` CLI does not honour
 * preload plugins. So we drive the build through the `Bun.build()` API
 * here and pass the plugin explicitly.
 *
 * Usage:
 *   bun run scripts/build.ts                          # native target
 *   bun run scripts/build.ts bun-darwin-arm64 ...     # cross-compile target
 *   bun run scripts/build.ts bun-darwin-x64 ...
 *   bun run scripts/build.ts bun-linux-arm64 ...
 *   bun run scripts/build.ts bun-linux-x64 ...
 *
 * The output filename can be overridden with $OUTFILE.
 */

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const target  = process.argv[2];                       // optional: cross-compile target
const outfile = process.env.OUTFILE ?? "defeatbeta";

const compileOptions: { outfile: string; target?: string } = { outfile };
if (target) compileOptions.target = target;

const result = await Bun.build({
  entrypoints: ["./src/main.tsx"],
  compile: compileOptions as never,                    // Bun 1.x types are loose here
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`✓ Built ${outfile}${target ? `  (target: ${target})` : ""}`);
