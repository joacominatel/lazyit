"use client";

import { AI_ENTITY_TYPES } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { humanizeKey } from "@/lib/ai/preview";

/** Localized entity-type label (`ai.entities.<type>`); a type this build does not know reads "Item". */
export function useEntityTypeLabel(): (type: string) => string {
  const t = useTranslations("ai.entities");
  return useCallback(
    (type: string) =>
      (AI_ENTITY_TYPES as readonly string[]).includes(type) ? t(type) : t("unknown"),
    [t],
  );
}

/**
 * A tool's display name. Tool names are data (snake case, set by the API); v1 shows them humanized —
 * `asset_search` → "Asset search" — rather than keeping a per-tool catalog in sync with the registry.
 */
export function toolDisplayName(name: string): string {
  return humanizeKey(name);
}
