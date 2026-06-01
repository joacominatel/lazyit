"use client";

import { MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useQuickAdjustStock } from "@/lib/api/hooks/use-consumable-movement-mutations";
import { notifyError } from "@/lib/api/notify-error";

interface QuickAdjustButtonsProps {
  consumableId: string;
  /** The consumable's display name, used in the success/blocked toasts. */
  name: string;
  /** Current on-hand count — `-1` is disabled at 0, and a successful adjust is echoed in the toast. */
  currentStock: number;
  unit: string;
  /** `icon-sm` for dense list rows, `sm` for the roomier detail header. Defaults to the dense size. */
  size?: "icon-sm" | "sm";
}

/**
 * One-click stock quick-adjust: a `−1` (consume one) and a `+1` (add one) button firing a minimal
 * quantity-1 OUT / IN movement with an optimistic `currentStock` bump and a Sonner toast (rolling
 * back on error). `−1` is disabled at 0 stock; if an OUT races to 0 the API's 409 is surfaced
 * cleanly. The detailed dialog (quantity / type / reason) stays available as a separate affordance.
 */
export function QuickAdjustButtons({
  consumableId,
  name,
  currentStock,
  unit,
  size = "icon-sm",
}: QuickAdjustButtonsProps) {
  const quickAdjust = useQuickAdjustStock();
  const compact = size === "icon-sm";

  function adjust(delta: 1 | -1) {
    quickAdjust.mutate(
      { consumableId, delta },
      {
        onSuccess: () => {
          const next = currentStock + delta;
          toast.success(
            delta > 0
              ? `Added 1 to ${name} — now ${next} ${unit}`
              : `Removed 1 from ${name} — now ${next} ${unit}`,
          );
        },
        onError: (error) => notifyError(error, "Couldn't adjust stock"),
      },
    );
  }

  // While 0, the API would reject an OUT (409); disable rather than let it race.
  const removeDisabled = currentStock <= 0 || quickAdjust.isPending;

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-label={`Remove one ${name}`}
        title={
          currentStock <= 0
            ? "Out of stock"
            : `Remove one ${name} (−1)`
        }
        disabled={removeDisabled}
        onClick={() => adjust(-1)}
      >
        <MinusIcon />
        {!compact && <span>1</span>}
      </Button>
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-label={`Add one ${name}`}
        title={`Add one ${name} (+1)`}
        disabled={quickAdjust.isPending}
        onClick={() => adjust(1)}
      >
        <PlusIcon />
        {!compact && <span>1</span>}
      </Button>
    </div>
  );
}
