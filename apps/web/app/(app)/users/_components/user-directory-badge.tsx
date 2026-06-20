"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

/**
 * The "Directory" marker (ADR-0069 REDESIGN §0 #2). A directory person is a User WITHOUT a login —
 * created by the bulk import as an asset's "assigned to", no Zitadel account (`directoryOnly === true`).
 * It IS a normal User row (it shows up in the list and selectors mixed with real accounts), so this
 * quiet `secondary` pill is the at-a-glance "this one has no login yet" signal — the same component on
 * the list row and the detail header so the vocabulary never drifts. Render it only when
 * `directoryOnly` is true; callers pass `user.directoryOnly` straight through.
 */
export function UserDirectoryBadge() {
  const t = useTranslations("users");
  return (
    <Badge variant="secondary" className="shrink-0">
      {t("directoryBadge")}
    </Badge>
  );
}
