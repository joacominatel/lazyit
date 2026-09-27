"use client";

import { AI_ENTITY_TYPES } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { humanizeKey } from "@/lib/ai/preview";
import { fieldLabelRef, toolNameKey } from "@/lib/ai/tool-labels";

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
 * A tool's display name (`ai.toolNames.<name>`, issue #1377). A tool this build has no label for — a
 * newer API — shows its humanized name (`asset_search` → "Asset search").
 */
export function useToolDisplayName(): (name: string) => string {
  const t = useTranslations("ai.toolNames");
  return useCallback(
    (name: string) => {
      const key = toolNameKey(name);
      return key !== null && t.has(key) ? t(key) : humanizeKey(name);
    },
    [t],
  );
}

/**
 * An approval-card field's label (`ai.fields.<key>`, or a templated `ai.fieldPrefixes.*` for `input.x` /
 * `specs.x`). An unknown key shows humanized.
 */
export function usePreviewFieldLabel(): (field: string) => string {
  const t = useTranslations("ai");
  return useCallback(
    (field: string) => {
      const ref = fieldLabelRef(field);
      if (ref.kind === "key" && t.has(`fields.${ref.key}`)) return t(`fields.${ref.key}`);
      if (ref.kind === "prefixed") return t(`fieldPrefixes.${ref.prefix}`, { name: ref.name });
      return humanizeKey(field);
    },
    [t],
  );
}
