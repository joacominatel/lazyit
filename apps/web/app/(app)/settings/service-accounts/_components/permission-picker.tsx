"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
  isAboveDefaultTier,
  type Permission,
  PERMISSION_META,
  type PermissionPillar,
  PERMISSIONS,
  PERMISSION_PILLARS,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  permissionLabel,
  pillarDescription,
  pillarLabel,
} from "../../_lib/permission-labels";

/**
 * The catalog grouped by pillar, in catalog order, computed once. A service account is authorized by
 * DIRECT catalog-permission grants (ADR-0048) — never a role and never the capability bundles humans
 * use — so the picker lists the RAW `domain:action` permissions (with their `PERMISSION_META` labels)
 * as individual checkboxes, the most precise grant surface.
 */
const PERMISSIONS_BY_PILLAR: Record<PermissionPillar, Permission[]> =
  PERMISSION_PILLARS.reduce(
    (acc, pillar) => {
      acc[pillar] = PERMISSIONS.filter(
        (p) => PERMISSION_META[p].pillar === pillar,
      );
      return acc;
    },
    {} as Record<PermissionPillar, Permission[]>,
  );

interface PermissionPickerProps {
  /** The currently-granted permission set. */
  value: ReadonlySet<Permission>;
  /** Toggle one permission on/off. */
  onToggle: (permission: Permission, on: boolean) => void;
  /** Toggle every permission in a pillar on (true) / off (false). */
  onTogglePillar: (pillar: PermissionPillar, on: boolean) => void;
  /** Disable every control (e.g. while the form is submitting). */
  disabled?: boolean;
  /** Stable prefix for the checkbox ids so two pickers on one screen don't collide. */
  idPrefix?: string;
}

/**
 * A checklist permission picker for a service account's direct grants (ADR-0048), grouped by the four
 * product pillars. Each permission shows its plain-language `PERMISSION_META` label; the delete + coarse
 * verbs carry the ⚠ "Admin-level" marker (mirroring the role config screen's `isAboveDefaultTier`) —
 * granting them is allowed but warned, never client-blocked (the backend doesn't block either). A
 * per-pillar "select all / none" header lets an operator grant a whole pillar in one click.
 *
 * Stateless: it renders from `value` and reports edits up via `onToggle` / `onTogglePillar`. The owning
 * form holds the staged set; the shared `ServiceAccountPermissionsSchema` (min 1) is the real guard.
 */
export function PermissionPicker({
  value,
  onToggle,
  onTogglePillar,
  disabled = false,
  idPrefix = "sa-perm",
}: PermissionPickerProps) {
  const t = useTranslations("settings");
  const pillars = useMemo(() => PERMISSION_PILLARS, []);

  return (
    <div className="space-y-4">
      {pillars.map((pillar) => {
        const perms = PERMISSIONS_BY_PILLAR[pillar];
        const pLabel = pillarLabel(t, pillar);
        const selectedCount = perms.filter((p) => value.has(p)).length;
        const allOn = selectedCount === perms.length;
        const someOn = selectedCount > 0 && !allOn;

        return (
          <section
            key={pillar}
            className="space-y-2 rounded-lg border p-3"
            aria-label={t("serviceAccounts.permissionPicker.sectionAria", {
              label: pLabel,
            })}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-sm font-semibold">{pLabel}</h4>
                <p className="text-xs text-muted-foreground">
                  {pillarDescription(t, pillar)}
                </p>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={allOn ? true : someOn ? "indeterminate" : false}
                  onCheckedChange={(v) => onTogglePillar(pillar, v === true)}
                  disabled={disabled}
                  aria-label={t(
                    "serviceAccounts.permissionPicker.selectAllAria",
                    { label: pLabel },
                  )}
                />
                {t("serviceAccounts.permissionPicker.all")}
              </label>
            </div>

            <ul className="space-y-1.5">
              {perms.map((permission) => {
                const checkboxId = `${idPrefix}-${permission}`;
                const aboveTier = isAboveDefaultTier(permission);
                return (
                  <li key={permission} className="flex items-center gap-2">
                    <Checkbox
                      id={checkboxId}
                      checked={value.has(permission)}
                      onCheckedChange={(v) => onToggle(permission, v === true)}
                      disabled={disabled}
                    />
                    <label
                      htmlFor={checkboxId}
                      className="flex flex-1 flex-wrap items-center gap-2 text-sm"
                    >
                      <span>{permissionLabel(t, permission)}</span>
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-muted-foreground">
                        {permission}
                      </code>
                      {aboveTier ? (
                        <StatusBadge
                          tone="warning"
                          className="gap-1 px-1.5 uppercase tracking-wide"
                        >
                          <ExclamationTriangleIcon aria-hidden />
                          {t("serviceAccounts.permissionPicker.adminLevel")}
                        </StatusBadge>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
