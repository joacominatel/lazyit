"use client";

import type { ConsumableMovementType } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";

/** Movement direction → shared status tone (IN adds → success, OUT subtracts → danger, set → info). */
const TONE: Record<ConsumableMovementType, StatusTone> = {
  IN: "success",
  OUT: "danger",
  ADJUSTMENT: "info",
};

/** Movement direction → the i18n key under `consumables.stock` for its display label. */
const LABEL_KEY: Record<ConsumableMovementType, string> = {
  IN: "movementTypeIn",
  OUT: "movementTypeOut",
  ADJUSTMENT: "movementTypeAdjustment",
};

/** Colored chip for a stock movement direction (IN adds, OUT subtracts, ADJUSTMENT sets). */
export function MovementTypeBadge({ type }: { type: ConsumableMovementType }) {
  const t = useTranslations("consumables");
  return <StatusBadge tone={TONE[type]}>{t(`stock.${LABEL_KEY[type]}`)}</StatusBadge>;
}
