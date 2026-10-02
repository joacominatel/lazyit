/**
 * Smart entry (#1470, ADR-0099 §7, Purchases UX proposal §4): the pure logic behind a free-text field
 * that suggests values entered before. Normalization, ranking, the near-duplicate check and the
 * per-viewer recent list live here so they can be tested without React; `components/suggest-input.tsx`
 * renders them.
 *
 * Nothing here ever replaces what the operator typed: it orders suggestions and reports a likely
 * duplicate, and the field decides what to show.
 */

import { moveHighlight } from "@/lib/ai/slash-commands";

/** One value the field may suggest, with what is known about its use. */
export interface SuggestCandidate {
  value: string;
  /** How many records use it (assets, models, purchases…). */
  count?: number;
  /** When it was last used. */
  lastUsedAt?: string | number | Date | null;
}

/** A ranked match: `tier` 0 is the best (see {@link rankSuggestions}). */
export interface RankedSuggestion extends SuggestCandidate {
  tier: number;
}

/**
 * Legal-form suffixes dropped from the end of a value before comparing (written without dots,
 * because dots are removed first: "S.A." → "sa").
 */
const LEGAL_SUFFIXES = new Set([
  "sa",
  "srl",
  "sas",
  "sl",
  "inc",
  "llc",
  "ltd",
  "gmbh",
  "corp",
  "co",
  "bv",
  "spa",
]);

/**
 * Fold a value for matching: accents stripped, lowercase, dots and apostrophes removed ("S.A." →
 * "sa"), every other run of punctuation or space collapsed to one space.
 */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The key two spellings of the same value share: the folded value without trailing legal suffixes
 * and without spaces. "Dell", "DELL", "Dell Inc." and "dell, inc" all key to `dell`. A value that is
 * only a suffix keeps it ("Co" stays `co`).
 */
export function suggestKey(value: string): string {
  const tokens = foldText(value).split(" ").filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join("");
}

/** The folded words of a value, splitting camel case too ("ThinkPad" → think, pad). */
function wordsOf(value: string): string[] {
  return foldText(value.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"))
    .split(" ")
    .filter(Boolean);
}

/** Optimal-string-alignment Damerau-Levenshtein distance (one transposition counts as one edit). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[rows - 1]![cols - 1]!;
}

function timeOf(value: SuggestCandidate["lastUsedAt"]): number {
  if (value == null) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Use counts compared by order of magnitude, so recency can still separate 40 from 50. */
function usageBucket(count: number | undefined): number {
  return Math.floor(Math.log2((count ?? 0) + 1));
}

/** Most used first, then most recently used, then alphabetical. */
function byUse(a: SuggestCandidate, b: SuggestCandidate): number {
  return (
    usageBucket(b.count) - usageBucket(a.count) ||
    timeOf(b.lastUsedAt) - timeOf(a.lastUsedAt) ||
    a.value.localeCompare(b.value)
  );
}

/**
 * Merge duplicate entries of the same exact value (blank values dropped): counts add up, the latest
 * use wins.
 */
export function mergeCandidates(
  candidates: readonly SuggestCandidate[],
): SuggestCandidate[] {
  const merged = new Map<string, SuggestCandidate>();
  for (const candidate of candidates) {
    const value = candidate.value.trim();
    if (value === "") continue;
    const seen = merged.get(value);
    if (!seen) {
      merged.set(value, { ...candidate, value });
      continue;
    }
    const count =
      seen.count === undefined && candidate.count === undefined
        ? undefined
        : (seen.count ?? 0) + (candidate.count ?? 0);
    const lastUsedAt =
      timeOf(candidate.lastUsedAt) > timeOf(seen.lastUsedAt)
        ? candidate.lastUsedAt
        : seen.lastUsedAt;
    merged.set(value, { value, count, lastUsedAt });
  }
  return [...merged.values()];
}

/**
 * Count how often each value appears in a set of records, keeping the latest date seen — turns any
 * list of rows (models, assets, purchases) into suggestion candidates.
 */
export function tallyValues(
  rows: readonly { value: string | null | undefined; at?: SuggestCandidate["lastUsedAt"] }[],
): SuggestCandidate[] {
  return mergeCandidates(
    rows
      .filter((row): row is { value: string; at?: SuggestCandidate["lastUsedAt"] } =>
        Boolean(row.value?.trim()),
      )
      .map((row) => ({ value: row.value, count: 1, lastUsedAt: row.at ?? null })),
  );
}

/**
 * The candidates matching what was typed, best first. Tiers:
 *
 * 0. **same value** — the normalized keys are equal ("DELL" for "Dell Inc.");
 * 1. **starts with** the query;
 * 2. **a word starts with** it, or the initials do ("tp" → "ThinkPad");
 * 3. **contains** it;
 * 4. **close spelling** — at most one edit for 4–7 typed characters, two from 8 ("Compumndo").
 *
 * Within a tier: most used, then most recently used, then the viewer's own recent order, then
 * alphabetical. A blank query matches nothing — {@link initialSuggestions} covers the empty field.
 */
export function rankSuggestions(
  candidates: readonly SuggestCandidate[],
  query: string,
  { recent = [], limit = 8 }: { recent?: readonly string[]; limit?: number } = {},
): RankedSuggestion[] {
  const q = foldText(query);
  if (q === "") return [];
  const qCompact = q.replace(/ /g, "");
  const qKey = suggestKey(query);
  const maxEdits = qCompact.length >= 8 ? 2 : qCompact.length >= 4 ? 1 : 0;

  const ranked: RankedSuggestion[] = [];
  for (const candidate of mergeCandidates(candidates)) {
    const folded = foldText(candidate.value);
    const compact = folded.replace(/ /g, "");
    const words = wordsOf(candidate.value);
    const initials = words.map((w) => w[0]).join("");
    let tier = -1;
    if (qKey !== "" && suggestKey(candidate.value) === qKey) tier = 0;
    else if (folded.startsWith(q) || compact.startsWith(qCompact)) tier = 1;
    else if (
      words.some((w) => w.startsWith(q)) ||
      (qCompact.length >= 2 && initials.startsWith(qCompact))
    )
      tier = 2;
    else if (folded.includes(q) || compact.includes(qCompact)) tier = 3;
    else if (
      maxEdits > 0 &&
      Math.min(
        editDistance(qCompact, compact),
        editDistance(qCompact, compact.slice(0, qCompact.length)),
        ...words.map((w) => editDistance(qCompact, w)),
      ) <= maxEdits
    )
      tier = 4;
    if (tier >= 0) ranked.push({ ...candidate, tier });
  }

  const recentIndex = (value: string) => {
    const index = recent.indexOf(value);
    return index === -1 ? recent.length : index;
  };
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      usageBucket(b.count) - usageBucket(a.count) ||
      timeOf(b.lastUsedAt) - timeOf(a.lastUsedAt) ||
      recentIndex(a.value) - recentIndex(b.value) ||
      a.value.localeCompare(b.value),
  );
  return ranked.slice(0, limit);
}

/**
 * What an empty, focused field offers before a key is pressed: the viewer's **recent** values (most
 * recent first), then the **most used** of the rest.
 */
export function initialSuggestions(
  candidates: readonly SuggestCandidate[],
  recent: readonly string[],
  { recentLimit = 5, otherLimit = 5 }: { recentLimit?: number; otherLimit?: number } = {},
): { recent: SuggestCandidate[]; others: SuggestCandidate[] } {
  const merged = mergeCandidates(candidates);
  const byValue = new Map(merged.map((c) => [c.value, c]));
  const recentList = recent
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, recentLimit)
    .map((value) => byValue.get(value) ?? { value });
  const taken = new Set(recentList.map((c) => c.value));
  const others = merged
    .filter((c) => !taken.has(c.value))
    .sort(byUse)
    .slice(0, otherLimit);
  return { recent: recentList, others };
}

/**
 * The existing value a typed one most likely duplicates: same normalized key, different spelling
 * ("DELL" → "Dell"). `null` when the value is blank, already exists exactly, or matches nothing. When
 * several spellings share the key, the most used one wins.
 */
export function findNearDuplicate(
  value: string,
  candidates: readonly SuggestCandidate[],
): SuggestCandidate | null {
  const typed = value.trim();
  const key = suggestKey(typed);
  if (key === "") return null;
  const merged = mergeCandidates(candidates);
  if (merged.some((c) => c.value === typed)) return null;
  const same = merged.filter((c) => suggestKey(c.value) === key).sort(byUse);
  return same[0] ?? null;
}

/** Put a just-used value at the front of the viewer's recent list, without duplicates. */
export function pushRecent(recent: readonly string[], value: string, limit = 5): string[] {
  const used = value.trim();
  if (used === "") return [...recent];
  return [used, ...recent.filter((v) => v !== used)].slice(0, limit);
}

/** What a key press does to a smart-entry field (see {@link suggestKeyAction}). */
export type SuggestKeyAction =
  | { type: "open"; highlight: number }
  | { type: "move"; highlight: number }
  /** Take the option at `index`; `preventDefault` is false for Tab, so focus still moves on. */
  | { type: "take"; index: number; preventDefault: boolean }
  /** Close the list and keep the text exactly as typed. */
  | { type: "keep"; preventDefault: boolean }
  | { type: "none" };

/**
 * The keyboard model of a smart-entry field, kept pure so it is testable without a DOM:
 *
 * - ↓ / ↑ open a closed list (on the first / last option) or move the highlight, wrapping;
 * - Enter takes the highlighted option; with Ctrl/Cmd it keeps the text as typed; with the list
 *   closed or nothing highlighted it does nothing, so the form submits as usual;
 * - Tab takes the highlighted option and lets focus move on; Shift+Tab, or nothing highlighted, just
 *   closes the list;
 * - Esc closes the list and keeps the text.
 *
 * `active` is the highlighted option (-1 for none) and `count` the options shown.
 */
export function suggestKeyAction(
  key: string,
  {
    open,
    active,
    count,
    shiftKey = false,
    modKey = false,
  }: { open: boolean; active: number; count: number; shiftKey?: boolean; modKey?: boolean },
): SuggestKeyAction {
  const picked = open && active >= 0 && active < count;
  switch (key) {
    case "ArrowDown":
    case "ArrowUp": {
      const delta = key === "ArrowDown" ? 1 : -1;
      if (count === 0) return { type: "none" };
      if (!open) return { type: "open", highlight: delta > 0 ? 0 : count - 1 };
      return { type: "move", highlight: moveHighlight(active, delta, count) };
    }
    case "Enter":
      if (!open) return { type: "none" };
      if (modKey) return { type: "keep", preventDefault: true };
      return picked ? { type: "take", index: active, preventDefault: true } : { type: "none" };
    case "Tab":
      if (picked && !shiftKey) return { type: "take", index: active, preventDefault: false };
      return open ? { type: "keep", preventDefault: false } : { type: "none" };
    case "Escape":
      // The list's popover closes itself on Escape; the field only forgets the highlight.
      return open ? { type: "keep", preventDefault: false } : { type: "none" };
    default:
      return { type: "none" };
  }
}
