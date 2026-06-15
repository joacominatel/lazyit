"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
  type Capability,
  capabilityIsAboveDefaultTier,
  type Permission,
  type PermissionPillar,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  capabilityDescription,
  capabilityLabel,
  pillarDescription,
  pillarLabel,
} from "../../../_lib/permission-labels";
import {
  capabilitiesForPillar,
  capabilityIsFullyOn,
  capabilityIsPartiallyOn,
} from "./permissions-form";

interface CapabilityGroupProps {
  pillar: PermissionPillar;
  /** The edited role's staged permission set (for deriving toggle state). */
  staged: ReadonlySet<Permission>;
  /** Toggle a capability fully on/off in the staged set. */
  onToggle: (capability: Capability, on: boolean) => void;
}

/**
 * One pillar's block of capability toggles (Inventory / Access / Knowledge / Manage). Each capability
 * is a single plain-language switch over the catalog permissions it bundles. Above-default-tier
 * capabilities (deletes + the coarse verbs) carry the ⚠ "Admin-level" marker — they are still
 * toggleable (CEO: warn, don't block), and flipping one on routes the eventual save through the
 * consequential confirm. A partially-on capability (some of its permissions present after a fine-tune
 * edit) shows a "Partial" hint; toggling it then fills or clears the whole bundle.
 */
export function CapabilityGroup({
  pillar,
  staged,
  onToggle,
}: CapabilityGroupProps) {
  const t = useTranslations("settings");
  const capabilities = capabilitiesForPillar(pillar);

  return (
    <section
      className="space-y-3"
      aria-label={t("roles.permissions.capabilityGroup.ariaLabel", {
        label: pillarLabel(t, pillar),
      })}
    >
      <div>
        <h3 className="text-sm font-semibold">{pillarLabel(t, pillar)}</h3>
        <p className="text-xs text-muted-foreground">
          {pillarDescription(t, pillar)}
        </p>
      </div>

      <ul className="divide-y rounded-lg border">
        {capabilities.map((cap) => {
          const fullyOn = capabilityIsFullyOn(cap, staged);
          const partiallyOn = !fullyOn && capabilityIsPartiallyOn(cap, staged);
          const aboveTier = capabilityIsAboveDefaultTier(cap);
          const capLabel = capabilityLabel(t, cap.id);
          return (
            <li
              key={cap.id}
              className="flex items-start justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{capLabel}</span>
                  {aboveTier && (
                    <StatusBadge
                      tone="warning"
                      className="gap-1 px-1.5 uppercase tracking-wide"
                    >
                      <ExclamationTriangleIcon aria-hidden />
                      {t("roles.permissions.capabilityGroup.adminLevel")}
                    </StatusBadge>
                  )}
                  {partiallyOn && (
                    <span className="rounded-full border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t("roles.permissions.capabilityGroup.partial")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {capabilityDescription(t, cap.id)}
                </p>
              </div>
              <Switch
                checked={fullyOn}
                onCheckedChange={(on) => onToggle(cap, on)}
                aria-label={capLabel}
                className={cn(
                  partiallyOn && "data-unchecked:bg-warning/40",
                )}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
