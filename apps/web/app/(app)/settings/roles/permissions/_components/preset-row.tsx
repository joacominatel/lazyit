"use client";

import { CheckIcon } from "@heroicons/react/24/outline";
import { PERMISSION_PRESETS, type PresetId } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface PresetRowProps {
  /** The preset the staged set currently matches, or `"custom"` after a manual edit. */
  active: PresetId | "custom";
  /** Stage a preset's full permission bundle (replaces the whole staged set; not saved). */
  onApply: (id: PresetId) => void;
}

/**
 * The presets row. Each named preset stages a full permission bundle for the edited role in one click
 * (Editor = the MEMBER seed default, Read-only = the VIEWER seed default, Inventory operator =
 * read/write Inventory + read elsewhere). "Custom (you edited)" is not clickable — it is the state the
 * row shows the moment the staged set matches no preset (after a capability/fine-tune edit), so an
 * admin always knows whether they're on a named baseline or a one-off.
 */
export function PresetRow({ active, onApply }: PresetRowProps) {
  const t = useTranslations("settings");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PERMISSION_PRESETS.map((preset) => {
          const isActive = active === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onApply(preset.id)}
              aria-pressed={isActive}
              className={cn(
                "group flex max-w-xs flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                isActive
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "hover:border-foreground/30 hover:bg-muted/40",
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {isActive && <CheckIcon className="size-4 text-primary" />}
                {preset.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {preset.description}
              </span>
            </button>
          );
        })}

        {/* Custom — passive marker, shown active only after a manual edit. */}
        <div
          className={cn(
            "flex max-w-xs flex-col items-start gap-0.5 rounded-lg border border-dashed px-3 py-2 text-left",
            active === "custom"
              ? "border-amber-500/50 bg-amber-500/5"
              : "opacity-60",
          )}
        >
          <span className="text-sm font-medium">
            {active === "custom"
              ? t("roles.permissions.preset.customEdited")
              : t("roles.permissions.preset.custom")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("roles.permissions.preset.customHint")}
          </span>
        </div>
      </div>
    </div>
  );
}
