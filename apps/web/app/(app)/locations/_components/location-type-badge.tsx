"use client";

import type { LocationType } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

/**
 * Resolves a {@link LocationType} enum value to its localized display label
 * (e.g. "DATACENTER" → "Datacenter" / "Centro de datos"). The enum value itself
 * is data and never translated — only its display label is.
 */
export function useLocationTypeLabel(): (type: LocationType) => string {
  const t = useTranslations("locations");
  return (type: LocationType) => t(`type.${type}`);
}

/** Small, neutral badge for a location's classification. */
export function LocationTypeBadge({ type }: { type: LocationType }) {
  const label = useLocationTypeLabel();
  return <Badge variant="secondary">{label(type)}</Badge>;
}
