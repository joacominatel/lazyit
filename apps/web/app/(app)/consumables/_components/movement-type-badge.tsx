import type { ConsumableMovementType } from "@lazyit/shared";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";

/** Movement direction → shared status tone (IN adds → success, OUT subtracts → danger, set → info). */
const TONE: Record<ConsumableMovementType, StatusTone> = {
  IN: "success",
  OUT: "danger",
  ADJUSTMENT: "info",
};

const LABEL: Record<ConsumableMovementType, string> = {
  IN: "In",
  OUT: "Out",
  ADJUSTMENT: "Adjust",
};

/** Colored chip for a stock movement direction (IN adds, OUT subtracts, ADJUSTMENT sets). */
export function MovementTypeBadge({ type }: { type: ConsumableMovementType }) {
  return <StatusBadge tone={TONE[type]}>{LABEL[type]}</StatusBadge>;
}
