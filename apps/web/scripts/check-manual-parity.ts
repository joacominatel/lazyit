#!/usr/bin/env bun
/**
 * Help / Manual en↔es parity lint (ADR-0062 §4 / "Negative trade-offs"). The Manual ships two
 * markdown trees that MUST stay in parity — a page present in one locale but missing in the
 * other is a documentation DEFECT (the reader silently falls back to `en`). This script FAILS
 * (exit 1) when any `content/manual/<locale>/*.md` lacks its counterpart in another locale, and
 * passes (exit 0) when every slug exists in every locale.
 *
 * Run via Bun (the tooling runtime — CLAUDE.md "Bun usage"): `bun run check:manual-parity`.
 * Locale set is read from `i18n/config` so it tracks the shipped locales automatically.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { locales } from "../i18n/config";

const CONTENT_ROOT = path.join(import.meta.dir, "..", "content", "manual");

/** Markdown slugs (basename without `.md`) present in a locale's tree; `[]` if the dir is absent. */
async function slugsForLocale(locale: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(CONTENT_ROOT, locale));
    return entries
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -".md".length))
      .sort();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const perLocale = new Map<string, Set<string>>();
  for (const locale of locales) {
    perLocale.set(locale, new Set(await slugsForLocale(locale)));
  }

  // The union of every slug across every locale — the set each locale is expected to cover.
  const allSlugs = new Set<string>();
  for (const set of perLocale.values()) {
    for (const slug of set) allSlugs.add(slug);
  }

  const problems: string[] = [];
  for (const slug of [...allSlugs].sort()) {
    const missingIn = locales.filter((locale) => !perLocale.get(locale)?.has(slug));
    if (missingIn.length > 0) {
      problems.push(
        `  • "${slug}" is missing in: ${missingIn.map((l) => `${l}/`).join(", ")}`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(
      `Manual parity check FAILED — ${problems.length} page(s) are not present in every locale:\n` +
        problems.join("\n") +
        `\n\nEvery content/manual/<locale>/<slug>.md must have a counterpart in all locales ` +
        `(${locales.join(", ")}). Add the missing file(s) and re-run.`,
    );
    process.exit(1);
  }

  console.log(
    `Manual parity OK — ${allSlugs.size} page(s) present in all locales (${locales.join(", ")}).`,
  );
}

await main();
