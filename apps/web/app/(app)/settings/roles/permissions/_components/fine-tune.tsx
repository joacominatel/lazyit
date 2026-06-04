"use client";

import {
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import {
  isAboveDefaultTier,
  type Permission,
  PERMISSION_META,
  PERMISSIONS,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface FineTuneProps {
  /** The edited role's staged permission set. */
  staged: ReadonlySet<Permission>;
  /** Toggle a single raw permission on/off (flips the preset to Custom upstream). */
  onToggle: (permission: Permission, on: boolean) => void;
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
 * The advanced "Fine-tune" disclosure, COLLAPSED by default. For the rare admin who needs exact
 * control, it exposes every raw `domain:action` permission as a checkbox, grouped by domain — the
 * full catalog, including the orphan `:write` slots the capability layer hides. Toggling a checkbox
 * here edits the same staged set the capability toggles do (so the preset flips to Custom and the
 * capability switches reflect it). Above-default-tier permissions carry the ⚠ marker, mirroring the
 * capability view.
 */
export function FineTune({ staged, onToggle }: FineTuneProps) {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-muted/40"
      >
        <ChevronRightIcon
          className={cn("size-4 transition-transform", open && "rotate-90")}
        />
        {t("roles.permissions.fineTune.title")}
        <span className="text-xs font-normal text-muted-foreground">
          {t("roles.permissions.fineTune.subtitle")}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t px-3 py-3">
          <p className="text-xs text-muted-foreground">
            {t("roles.permissions.fineTune.description")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {PERMISSIONS_BY_DOMAIN.map(({ domain, permissions }) => (
              <fieldset key={domain} className="space-y-1.5">
                <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {domain}
                </legend>
                <ul className="space-y-1">
                  {permissions.map((p) => {
                    const checked = staged.has(p);
                    const aboveTier = isAboveDefaultTier(p);
                    return (
                      <li key={p}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/40">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(state) =>
                              onToggle(p, state === true)
                            }
                            aria-label={p}
                          />
                          <span className="flex-1">{PERMISSION_META[p].label}</span>
                          <code className="text-[11px] text-muted-foreground">
                            {p}
                          </code>
                          {aboveTier && (
                            <ExclamationTriangleIcon
                              className="size-3.5 text-amber-600 dark:text-amber-500"
                              aria-label={t(
                                "roles.permissions.fineTune.adminLevel",
                              )}
                            />
                          )}
                        </label>
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
