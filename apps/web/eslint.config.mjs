import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ADR-0049 «Activated Restraint» anti-rot guard: raw Tailwind palette utilities
// (bg-/text-/ring-/border-{emerald,sky,violet,amber,rose,teal,indigo}-NNN) bypass the
// token system and break dark-mode parity — exactly the drift that produced the original
// TONE/ENTITY_TONE/EVENT_TONE breaks. Status colour → semantic tokens (--success/...);
// area colour → bg-pillar-*/text-pillar-*; categorical → --chart-*. Matched against any
// string/template literal so it catches className strings and the *_TONE maps.
//
// Severity is `warn`, not `error`: Wave 0 de-hardcodes the three named breaks, but a sweep
// found ~15 PRE-EXISTING raw-palette usages on the Roles/Permissions, Service-accounts and
// Setup surfaces (amber=warning, emerald=ok). De-hardcoding those is Wave-1+ surface work
// (and several are tint-with-coloured-text patterns needing per-case AA judgement), out of
// this foundation's scope. A warning keeps that debt VISIBLE and flags any NEW drift in
// review without big-bang-touching 11 out-of-scope files or breaking CI. Tighten to `error`
// once those surfaces are de-hardcoded.
const RAW_PALETTE_RE =
  /\b(?:bg|text|ring|border|from|via|to|fill|stroke|outline|decoration|shadow|accent|caret|divide|ring-offset)-(?:emerald|sky|violet|amber|rose|teal|indigo)-(?:50|[1-9]00|950)\b/;
const RAW_PALETTE_MESSAGE =
  "Raw Tailwind palette colour is banned in web feature code (ADR-0049). Use the semantic " +
  "tokens (--success/--warning/--info/--destructive), the pillar utilities " +
  "(bg-pillar-*/text-pillar-*), or the chart tokens (bg-chart-*) instead.";

// #1125 anti-rot guard: WebCrypto APIs that are **secure-context-only** (HTTPS or `localhost`).
// A self-hosted lazyit reached over plain HTTP on a LAN IP is a first-class deployment shape
// (ADR-0087) — there `window.crypto` exists but `randomUUID` and `subtle` are `undefined`, so a
// bare call throws at runtime. Development never reproduces it (`localhost` IS a secure context),
// which is how #946/#970 shipped a crash that made the workflow builder unusable in production.
//
// `crypto.getRandomValues` is deliberately NOT banned — it is available in insecure contexts.
// For React list keys use `@/lib/list-key`; for hashing/HMAC use the already-installed `@noble/*`
// pure-JS primitives; for clipboard writes use `@/lib/secret-manager/clipboard`.
const SECURE_CONTEXT_ONLY_MESSAGE =
  "This WebCrypto API is secure-context-only (HTTPS/localhost) and is `undefined` on plain-HTTP " +
  "LAN installs (ADR-0087, #1125). Use `nextListKey()` from @/lib/list-key for React list keys, " +
  "or the pure-JS @noble/* primitives for hashing/HMAC.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    name: "lazyit/no-raw-palette-colors",
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    // Vendored shadcn primitives are regenerated, not hand-authored — leave them out.
    ignores: ["components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: `Literal[value=/${RAW_PALETTE_RE.source}/]`,
          message: RAW_PALETTE_MESSAGE,
        },
        {
          selector: `TemplateElement[value.raw=/${RAW_PALETTE_RE.source}/]`,
          message: RAW_PALETTE_MESSAGE,
        },
      ],
    },
  },
  {
    name: "lazyit/no-secure-context-only-crypto",
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.ts"],
    // `totp.ts` is the one KNOWN remaining offender (TOTP codes are dead on plain HTTP) — tracked
    // as #1126, which swaps `crypto.subtle` for @noble/hashes. Drop this ignore when it lands.
    ignores: ["components/ui/**", "lib/secret-manager/totp.ts"],
    rules: {
      // `no-restricted-properties`, NOT `no-restricted-syntax`: flat config REPLACES a rule's
      // options per matching file, so a second `no-restricted-syntax` block would silently
      // disable the raw-palette guard above on every file both blocks match.
      "no-restricted-properties": [
        "error",
        {
          object: "crypto",
          property: "randomUUID",
          message: SECURE_CONTEXT_ONLY_MESSAGE,
        },
        {
          object: "crypto",
          property: "subtle",
          message: SECURE_CONTEXT_ONLY_MESSAGE,
        },
      ],
    },
  },
]);

export default eslintConfig;
