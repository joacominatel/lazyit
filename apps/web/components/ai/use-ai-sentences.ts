"use client";

import { createTranslator, useFormatter, useLocale, useMessages, useTimeZone, useTranslations } from "next-intl";
import { useMemo } from "react";
import { renderAiSentences, type SentenceRenderer } from "@/lib/ai/sentences";
import { usePreviewFieldLabel } from "./ai-labels";

/** `asset models` (a word the API lists in `taxonomy.usedByUnknown`) → its `ai.sentenceValues` key. */
const TAXONOMY_DEPENDENTS: Record<string, string> = {
  "asset models": "assetModels",
  assets: "assets",
  applications: "applications",
  consumables: "consumables",
  "child locations": "childLocations",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "Name" → "name" inside a sentence; an acronym ("URL") stays. */
function inSentence(label: string): string {
  return label.length > 1 && label[1] === label[1]!.toUpperCase() && label[1] !== label[1]!.toLowerCase()
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}

interface RendererDeps {
  locale: string;
  timeZone: string | undefined;
  messages: unknown;
  format: ReturnType<typeof useFormatter>;
  fieldLabel: (field: string) => string;
  dependentLabel: (key: string) => string;
}

/** Throws, so next-intl never falls back to a message key: the caller shows the English instead. */
function rethrow(error: Error): never {
  throw error;
}

function buildRenderer({ locale, timeZone, messages, format, fieldLabel, dependentLabel }: RendererDeps): SentenceRenderer {
  const catalog = (messages as { ai?: { sentences?: Record<string, unknown> } } | undefined)?.ai?.sentences;
  if (!catalog) return () => null;
  const t = createTranslator({
    locale,
    timeZone,
    messages: { sentences: catalog },
    namespace: "sentences",
    onError: rethrow,
  } as Parameters<typeof createTranslator>[0]) as unknown as {
    (key: string, values?: Record<string, string | number>): string;
    has: (key: string) => boolean;
  };

  const date = (iso: string): string => {
    if (DAY.test(iso)) {
      const day = new Date(`${iso}T00:00:00Z`);
      return Number.isNaN(day.getTime()) ? iso : format.dateTime(day, { dateStyle: "medium", timeZone: "UTC" });
    }
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : format.dateTime(at, { dateStyle: "medium", timeStyle: "short" });
  };

  const enumItem = (kind: string, item: string): string | null => {
    if (kind === "enum:PreviewFieldList") return inSentence(fieldLabel(item));
    if (kind === "enum:TaxonomyDependentList") {
      const key = TAXONOMY_DEPENDENTS[item];
      return key !== undefined ? dependentLabel(key) : null;
    }
    return null;
  };

  return (sentences) =>
    renderAiSentences(sentences, {
      format: (code, values) => t(code, values),
      has: (code) => t.has(code),
      date,
      enumItem,
    });
}

/**
 * The renderer for the assistant's server-built sentences in the user's locale (#1384; `lib/ai/sentences.ts`).
 * Templates come from `ai.sentences.<code>`, formatted by next-intl's ICU formatter with a translator that
 * THROWS on any formatting problem, so a sentence that cannot be rendered whole falls back to the English
 * instead of showing a message key.
 */
export function useAiSentences(): SentenceRenderer {
  const locale = useLocale();
  const messages = useMessages();
  const timeZone = useTimeZone();
  const format = useFormatter();
  const fieldLabel = usePreviewFieldLabel();
  const tValues = useTranslations("ai.sentenceValues");

  return useMemo(
    () =>
      buildRenderer({
        locale,
        timeZone,
        messages,
        format,
        fieldLabel,
        dependentLabel: (key) => tValues(`taxonomyDependents.${key}`),
      }),
    [locale, timeZone, messages, format, fieldLabel, tValues],
  );
}
