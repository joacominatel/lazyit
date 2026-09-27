import { AI_SENTENCES, isAiSentenceCode, type AiSentenceParamKind } from "@lazyit/shared";
import { stripUntrusted, type CleanText } from "./untrusted-text";

/**
 * The assistant's server-built sentences in the user's language (#1384; tools-and-execution.md §9.1;
 * frontend.md §5.3). Next to a few English strings — the approval card's `action` row and other
 * explanatory values, a result's summary, a refusal — the API sends the same sentence as codes + params
 * (`AI_SENTENCES` in `@lazyit/shared`). This module renders such a list with the web's own templates
 * (`ai.sentences.<code>`), joined by one space.
 *
 * READ-TOLERANT, all or nothing: the localized form is used only when EVERY code is known to this build
 * and every param its template names is present with a usable value; otherwise the caller shows the
 * English field. A missing field is the English, too. The result is plain text — `<untrusted_content>`
 * wrappers in text params are stripped here, like everywhere else in the chat — and is rendered as escaped
 * React text, never HTML.
 */

/** Renders one code's template with prepared values; THROWS when it cannot (unknown code, bad params). */
export type SentenceFormat = (code: string, values: Record<string, string | number>) => string;

export interface SentenceRenderOptions {
  format: SentenceFormat;
  /** Whether this build's catalog has the code (defaults to the shared closed list). */
  has?: (code: string) => boolean;
  /** A `date` param (`2026-10-01` or an ISO date-time) in the user's locale; unparseable → shown as sent. */
  date?: (iso: string) => string;
  /** A list-valued enum param's items (`enum:PreviewFieldList`…), each mapped to a label; null = as sent. */
  enumItem?: (kind: string, item: string) => string | null;
}

/** The longest list the contract allows (`AiSentenceListSchema`). */
const MAX_SENTENCES = 20;

/**
 * Enum kinds the templates print as they are (not a `select` subject) and whose value is a
 * comma-separated list of raw words — mapped item by item through `enumItem`. Every other enum kind is a
 * `select` subject (or a single raw code a template's own `select` branches name) and passes unchanged.
 */
export const LIST_ENUM_KINDS = ["enum:PreviewFieldList", "enum:TaxonomyDependentList"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Prepared {
  values: Record<string, string | number>;
  untrusted: boolean;
}

/** One sentence's params, checked against its code's declared params and prepared for the template. */
function prepare(
  kinds: Readonly<Record<string, AiSentenceParamKind>>,
  params: Record<string, unknown>,
  options: SentenceRenderOptions,
): Prepared | null {
  const values: Record<string, string | number> = {};
  let untrusted = false;
  for (const [name, kind] of Object.entries(kinds)) {
    if (!Object.hasOwn(params, name)) return null;
    const raw = params[name];
    if (kind === "number") {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return null;
      values[name] = n;
      continue;
    }
    if (typeof raw !== "string" && !(typeof raw === "number" && Number.isFinite(raw))) return null;
    const value = String(raw);
    if (kind === "text") {
      const clean = stripUntrusted(value);
      untrusted ||= clean.untrusted;
      values[name] = clean.text;
    } else if (kind === "date") {
      values[name] = value !== "" && options.date ? options.date(value) : value;
    } else if ((LIST_ENUM_KINDS as readonly string[]).includes(kind) && options.enumItem) {
      values[name] = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "")
        .map((item) => options.enumItem!(kind, item) ?? item)
        .join(", ");
    } else {
      values[name] = value;
    }
  }
  return { values, untrusted };
}

/**
 * A sentence list in the user's language, or null when it cannot be rendered whole (then the caller shows
 * the English). Anything that is not a well-formed list of 1–20 known sentences is null. Pure.
 */
export function renderAiSentences(sentences: unknown, options: SentenceRenderOptions): CleanText | null {
  if (!Array.isArray(sentences) || sentences.length === 0 || sentences.length > MAX_SENTENCES) return null;
  const has = options.has ?? isAiSentenceCode;
  const texts: string[] = [];
  let untrusted = false;
  for (const sentence of sentences) {
    if (!isObject(sentence) || typeof sentence.code !== "string" || !isObject(sentence.params)) return null;
    const { code } = sentence;
    if (!isAiSentenceCode(code) || !has(code)) return null;
    const prepared = prepare(AI_SENTENCES[code].params, sentence.params, options);
    if (prepared === null) return null;
    let text: string;
    try {
      text = options.format(code, prepared.values);
    } catch {
      return null;
    }
    untrusted ||= prepared.untrusted;
    texts.push(text);
  }
  return { text: texts.join(" "), untrusted };
}

/** Renders a list; null when it cannot (the caller falls back to the English). */
export type SentenceRenderer = (sentences: unknown) => CleanText | null;

/** The localized sentence list, else the English field (wrappers stripped), else null when there is neither. */
export function localizedText(
  english: string | undefined,
  sentences: unknown,
  render: SentenceRenderer | undefined,
): CleanText | null {
  const localized = sentences !== undefined && render ? render(sentences) : null;
  if (localized !== null) return localized;
  return english === undefined ? null : stripUntrusted(english);
}
