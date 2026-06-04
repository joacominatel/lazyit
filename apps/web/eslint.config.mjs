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
]);

export default eslintConfig;
