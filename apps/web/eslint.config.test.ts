import { expect, test } from "bun:test";
import { ESLint } from "eslint";
import { resolve } from "node:path";

/**
 * #1125/#1126 anti-rot guard — a test for the GUARD ITSELF, not for a module.
 *
 * `lib/secret-manager/totp.ts` and `lib/list-key.ts` exist because `crypto.subtle` and
 * `crypto.randomUUID` are secure-context-only and are `undefined` on a plain-HTTP LAN install
 * (ADR-0087). The ESLint block in `eslint.config.mjs` is what stops that bug class from coming
 * back — so its coverage has to be pinned, not assumed.
 *
 * WHY this test exists: the guard originally used `no-restricted-properties` with an `object:`
 * key, which ESLint matches ONLY when the member-expression object is a bare `Identifier`. That
 * caught `crypto.subtle` but silently let through `window.crypto.subtle`,
 * `globalThis.crypto.subtle`, `self.crypto.subtle` and any local alias — the forms a developer is
 * at least as likely to write (this very repo's TOTP test used `globalThis.crypto.subtle`). Lint
 * would have been green while the crash shipped again. The restriction is now property-only, and
 * the matrix below is what keeps it that way.
 */
const WEB_ROOT = resolve(import.meta.dir);

// A path inside the guard's `files` globs — the block only applies to app/**, components/** and lib/**.
const GUARDED_FILE = resolve(WEB_ROOT, "lib/__eslint_guard_fixture__.ts");

const eslint = new ESLint({ cwd: WEB_ROOT });

async function guardHits(code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: GUARDED_FILE });
  return (result?.messages ?? []).filter(
    (message) => message.ruleId === "no-restricted-properties",
  ).length;
}

/**
 * Every way a developer can reach the banned APIs. `window.`/`globalThis.`/`self.` prefixes and
 * aliasing are not exotic — they are what you write in a worker, in SSR-guarded code, or after a
 * `const c = crypto` extraction.
 */
const MUST_BE_FLAGGED: Record<string, string> = {
  "crypto.subtle": `crypto.subtle.digest("SHA-1", new Uint8Array());`,
  'crypto["subtle"]': `crypto["subtle"].digest("SHA-1", new Uint8Array());`,
  "window.crypto.subtle": `window.crypto.subtle.digest("SHA-1", new Uint8Array());`,
  "globalThis.crypto.subtle": `globalThis.crypto.subtle.digest("SHA-1", new Uint8Array());`,
  "self.crypto.subtle": `self.crypto.subtle.digest("SHA-1", new Uint8Array());`,
  "aliased crypto .subtle": `const c = crypto;\nc.subtle.digest("SHA-1", new Uint8Array());`,
  "crypto.randomUUID": `crypto.randomUUID();`,
  "window.crypto.randomUUID": `window.crypto.randomUUID();`,
  "globalThis.crypto.randomUUID": `globalThis.crypto.randomUUID();`,
  "self.crypto.randomUUID": `self.crypto.randomUUID();`,
  "aliased crypto .randomUUID": `const c = crypto;\nc.randomUUID();`,
};

/**
 * `getRandomValues` IS available in an insecure context, so banning it would push people toward
 * worse workarounds for no safety gain. Pin the non-ban so a future tightening stays deliberate.
 */
const MUST_NOT_BE_FLAGGED: Record<string, string> = {
  "crypto.getRandomValues": `crypto.getRandomValues(new Uint8Array(16));`,
  "globalThis.crypto.getRandomValues": `globalThis.crypto.getRandomValues(new Uint8Array(16));`,
};

for (const [name, code] of Object.entries(MUST_BE_FLAGGED)) {
  test(
    `secure-context guard flags ${name}`,
    async () => {
      expect(await guardHits(code)).toBeGreaterThan(0);
    },
    30_000,
  );
}

for (const [name, code] of Object.entries(MUST_NOT_BE_FLAGGED)) {
  test(
    `secure-context guard allows ${name}`,
    async () => {
      expect(await guardHits(code)).toBe(0);
    },
    30_000,
  );
}
