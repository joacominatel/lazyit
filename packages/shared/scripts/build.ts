/**
 * Build `@lazyit/shared` (issue #429, ADR-0014).
 *
 * Two emits + one marker:
 *   1. CJS (tsconfig.build.json)        -> dist/**            — the main `.` barrel + everything,
 *      CommonJS, consumed by apps/api's CommonJS Jest and the Node-compiled API.
 *   2. ESM crypto (tsconfig.crypto-esm) -> dist/esm/crypto/** — a real ES-module build of the
 *      `@lazyit/shared/crypto` subpath ONLY. `@noble/*` is ESM-only, so the subpath ships ESM
 *      (the `exports` `import` condition) for apps/web's Next bundler and bun's test runtime.
 *   3. dist/esm/package.json {"type":"module"} — marks every `.js` under dist/esm/ as an ES
 *      module; the package root has no "type", so the rest of dist/ stays CommonJS.
 *
 * Run via Bun (the repo's tooling runtime). `bunx tsc` is invoked twice; on the first failure the
 * process exits non-zero so the build fails loudly.
 */
import { $ } from "bun";

await $`tsc -p tsconfig.build.json`;
await $`tsc -p tsconfig.crypto-esm.json`;

// Per-folder ESM marker so Node/bun treat dist/esm/**/*.js as ES modules.
await Bun.write("dist/esm/package.json", `${JSON.stringify({ type: "module" }, null, 2)}\n`);
