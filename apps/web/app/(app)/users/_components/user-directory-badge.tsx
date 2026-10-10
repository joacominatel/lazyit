"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

/** A User without a login yet (`directoryOnly`, ADR-0069 REDESIGN §0 #2); render only when it is true. */
export function UserDirectoryBadge() {
  const t = useTranslations("users");
  return (
    <Badge variant="secondary" className="shrink-0">
      {t("directoryBadge")}
    </Badge>
  );
}
