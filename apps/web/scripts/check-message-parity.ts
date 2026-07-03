#!/usr/bin/env bun
/**
 * Message-catalog en↔es key parity lint (#965). `apps/web/messages/<locale>/*.json` is one
 * JSON file per namespace (assets.json, users.json, …), assembled by `_all.ts` into the
 * catalog `next-intl` loads. A key present in one locale but missing in the other means the
 * reader silently falls back to `en` (or, for a key missing in `en`, that ES ships copy no
 * English caller can render) — the exact drift class ADR-0051 flagged as "CI cannot catch"
 * (see #941/#942/#964). This script deep-collects every leaf key path per namespace file and
 * diffs the two locales, mirroring `check-manual-parity.ts`'s shape for the Manual tree.
 *
 * ponytail: narrower than a full schema check (doesn't compare value TYPES, only which key
 * paths exist) — that's the smallest thing that catches the drift class actually seen so far.
 * Note on overlap: `messages/permission-i18n-coverage.test.ts` already guards en+es parity for
 * ONE namespace (settings.json's permission-derived keys, sourced from @lazyit/shared). This
 * script is broader (every namespace file, both directions) but doesn't replace that test —
 * that test also asserts the shared permission catalog is fully covered, not just en≡es.
 *
 * Run via Bun (the tooling runtime — CLAUDE.md "Bun usage"): `bun run check:message-parity`.
 * Locale set is read from `i18n/config` so it tracks the shipped locales automatically.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { locales } from "../i18n/config";

const MESSAGES_ROOT = path.join(import.meta.dir, "..", "messages");

/** Namespace filenames (e.g. "assets.json") in a locale dir; `[]` if the dir is absent. */
async function namespacesForLocale(locale: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(MESSAGES_ROOT, locale));
    return entries.filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** Recursively collects dotted leaf key paths from a JSON message object. */
function collectKeyPaths(node: unknown, prefix: string, out: Set<string>): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    out.add(prefix);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    collectKeyPaths(value, prefix ? `${prefix}.${key}` : key, out);
  }
}

async function keyPathsForNamespace(locale: string, namespace: string): Promise<Set<string>> {
  const filePath = path.join(MESSAGES_ROOT, locale, namespace);
  const out = new Set<string>();
  try {
    const json = await Bun.file(filePath).json();
    collectKeyPaths(json, "", out);
  } catch {
    // Namespace file absent for this locale — reported separately below.
  }
  return out;
}

async function main(): Promise<void> {
  const perLocaleNamespaces = new Map<string, Set<string>>();
  for (const locale of locales) {
    perLocaleNamespaces.set(locale, new Set(await namespacesForLocale(locale)));
  }

  const allNamespaces = new Set<string>();
  for (const set of perLocaleNamespaces.values()) {
    for (const ns of set) allNamespaces.add(ns);
  }

  const problems: string[] = [];
  let namespaceCount = 0;
  let keyCount = 0;

  for (const namespace of [...allNamespaces].sort()) {
    const missingIn = locales.filter((locale) => !perLocaleNamespaces.get(locale)?.has(namespace));
    if (missingIn.length > 0) {
      problems.push(`  • "${namespace}" is missing entirely in: ${missingIn.map((l) => `${l}/`).join(", ")}`);
      continue;
    }

    namespaceCount += 1;
    const perLocaleKeys = new Map<string, Set<string>>();
    for (const locale of locales) {
      perLocaleKeys.set(locale, await keyPathsForNamespace(locale, namespace));
    }

    const allKeys = new Set<string>();
    for (const set of perLocaleKeys.values()) {
      for (const key of set) allKeys.add(key);
    }
    keyCount += allKeys.size;

    for (const key of [...allKeys].sort()) {
      const missingKeyIn = locales.filter((locale) => !perLocaleKeys.get(locale)?.has(key));
      if (missingKeyIn.length > 0) {
        problems.push(
          `  • ${namespace} → "${key}" is missing in: ${missingKeyIn.map((l) => `${l}/`).join(", ")}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      `Message parity check FAILED — ${problems.length} drift(s) between locale catalogs:\n` +
        problems.join("\n") +
        `\n\nEvery key path under messages/<locale>/<namespace>.json must have a counterpart in ` +
        `all locales (${locales.join(", ")}). Fix the catalog(s) and re-run.`,
    );
    process.exit(1);
  }

  console.log(
    `Message parity OK — ${namespaceCount} namespace(s), ${keyCount} key(s) present in all locales (${locales.join(", ")}).`,
  );
}

await main();
