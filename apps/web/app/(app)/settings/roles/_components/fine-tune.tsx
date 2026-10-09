"use client";

import {
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import {
  type EditableRole,
  EDITABLE_ROLES,
  isAboveDefaultTier,
  type Permission,
  PERMISSIONS,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { permissionLabel } from "../../_lib/permission-labels";

interface FineTuneProps {
  /** Each editable role's staged permission set. */
  staged: Record<EditableRole, ReadonlySet<Permission>>;
  /** Toggle a single raw permission on/off for one role (flips its preset to Custom upstream). */
  onToggle: (role: EditableRole, permission: Permission, on: boolean) => void;
}

/** The catalog grouped by domain (the noun half of `domain:action`), in catalog order. */
const PERMISSIONS_BY_DOMAIN: { domain: string; permissions: Permission[] }[] =
  (() => {
    const order: string[] = [];
    const groups = new Map<string, Permission[]>();
    for (const p of PERMISSIONS) {
      const domain = p.split(":")[0]!;
      if (!groups.has(domain)) {
        groups.set(domain, []);
        order.push(domain);
      }
      groups.get(domain)!.push(p);
    }
    return order.map((domain) => ({ domain, permissions: groups.get(domain)! }));
  })();

/**
 * The advanced "Fine-tune" disclosure under the role matrix, COLLAPSED by default. For the rare admin
 * who needs exact control it lists every raw `domain:action` permission, grouped by domain, with one
 * checkbox per editable role — the full catalog, including the slots the capability layer hides. It
 * edits the same staged sets as the matrix, so a change here flips that
 * role's preset to Custom and shows as a partial cell above. Above-default-tier permissions carry ⚠.
 */
export function FineTune({ staged, onToggle }: FineTuneProps) {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-4 py-3 text-left text-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          className={cn("size-4 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        {t("roles.permissions.fineTune.title")}
        <span className="text-xs font-normal text-muted-foreground">
          {t("roles.permissions.fineTune.subtitle")}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t px-4 py-4">
          <p className="text-xs text-muted-foreground">
            {t("roles.permissions.fineTune.description")}
          </p>
          <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
            {PERMISSIONS_BY_DOMAIN.map(({ domain, permissions }) => (
              <fieldset key={domain} className="min-w-0 space-y-1">
                <legend className="flex w-full items-center gap-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <span className="flex-1">{domain}</span>
                  {EDITABLE_ROLES.map((role) => (
                    <span key={role} className="w-14 text-center text-[10px]">
                      {t(`roles.meta.${role}.label`)}
                    </span>
                  ))}
                </legend>
                <ul className="divide-y rounded-lg border">
                  {permissions.map((p) => {
                    const label = permissionLabel(t, p);
                    return (
                      <li key={p} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{label}</span>
                          <code className="block truncate text-xs text-muted-foreground">
                            {p}
                          </code>
                        </span>
                        {isAboveDefaultTier(p) ? (
                          <ExclamationTriangleIcon
                            className="size-3.5 shrink-0 text-warning-text"
                            role="img"
                            aria-label={t("roles.permissions.fineTune.adminLevel")}
                          />
                        ) : null}
                        {EDITABLE_ROLES.map((role) => (
                          <span key={role} className="flex w-14 justify-center">
                            <Checkbox
                              checked={staged[role].has(p)}
                              onCheckedChange={(state) => onToggle(role, p, state === true)}
                              aria-label={t("roles.matrix.cellLabel", {
                                capability: label,
                                role: t(`roles.meta.${role}.label`),
                              })}
                            />
                          </span>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
