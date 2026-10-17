"use client";

import { LockClosedIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * The ONE padlock a restricted KB folder shows (ADR-0060, #414, #1539): its own rule in the warning
 * tone, an inherited restriction in a muted warning tone whose tooltip names the ancestor. The icon is
 * decorative; the meaning travels as visually-hidden text so it joins the accessible name of the row
 * or link around it. Presentation only — the API enforces access (INV-9).
 */
export function RestrictionPadlock({
  inheritedFrom,
  className,
}: {
  /** The restricting ancestor's name for an inherited restriction; `null` for the folder's own rule. */
  inheritedFrom: string | null;
  className?: string;
}) {
  const t = useTranslations("kb");
  const label =
    inheritedFrom === null
      ? t("access.restrictedAriaLabel")
      : t("access.inheritedRestrictedAriaLabel", { name: inheritedFrom });
  const tooltip =
    inheritedFrom === null
      ? t("access.restrictedTooltip")
      : t("access.inheritedRestrictedTooltip", { name: inheritedFrom });
  return (
    <span title={tooltip} className={cn("inline-flex shrink-0", className)}>
      <LockClosedIcon
        aria-hidden
        className={cn(
          "size-3.5",
          inheritedFrom === null ? "text-warning" : "text-warning/60",
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
