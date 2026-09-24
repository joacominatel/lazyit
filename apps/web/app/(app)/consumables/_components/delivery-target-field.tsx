"use client";

import { useTranslations } from "next-intl";
import { AssetCombobox } from "@/components/asset-combobox";
import { LocationCombobox } from "@/components/location-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserCombobox } from "@/components/user-combobox";
import type { DeliveryTargetKind } from "@/lib/consumables/deliveries";

/** The "Deliver to" choice: nobody (a plain removal) or one of the three target kinds. */
export type DeliveryTargetChoice = "none" | DeliveryTargetKind;

const CHOICES: DeliveryTargetChoice[] = ["none", "user", "asset", "location"];

/**
 * The optional "Deliver to" control of the Remove dialog (ADR-0098): a kind select, then ONE entity
 * picker for that kind. The pickers are the app's existing server-search comboboxes, which only offer
 * live rows — the user list is active-only (offboarded people are soft-deleted and never listed, and the
 * picker also hides deactivated ones), and the asset / location lists exclude soft-deleted rows — so a
 * dead target cannot be picked (the API refuses one with a 400 regardless).
 */
export function DeliveryTargetField({
  kind,
  onKindChange,
  targetId,
  onTargetIdChange,
  targetError,
  disabled,
}: {
  kind: DeliveryTargetChoice;
  onKindChange: (kind: DeliveryTargetChoice) => void;
  targetId: string;
  onTargetIdChange: (id: string) => void;
  /** Set when a kind is chosen but no entity picked yet (after a submit attempt). */
  targetError?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("consumables.stock.dialog.target");
  const pickerProps = {
    id: "movement-target",
    value: targetId,
    onValueChange: onTargetIdChange,
    ariaInvalid: Boolean(targetError) || undefined,
    disabled,
  };

  return (
    <div className="space-y-2">
      <Select
        value={kind}
        onValueChange={(value) => onKindChange(value as DeliveryTargetChoice)}
        disabled={disabled}
      >
        <SelectTrigger id="movement-target-kind" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CHOICES.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {t(`kinds.${choice}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {kind === "user" ? (
        <UserCombobox
          {...pickerProps}
          placeholder={t("userPlaceholder")}
          searchPlaceholder={t("userSearch")}
          emptyText={t("userEmpty")}
        />
      ) : kind === "asset" ? (
        <AssetCombobox
          {...pickerProps}
          placeholder={t("assetPlaceholder")}
          searchPlaceholder={t("assetSearch")}
          emptyText={t("assetEmpty")}
        />
      ) : kind === "location" ? (
        <LocationCombobox
          {...pickerProps}
          placeholder={t("locationPlaceholder")}
          searchPlaceholder={t("locationSearch")}
          emptyText={t("locationEmpty")}
        />
      ) : null}
    </div>
  );
}
