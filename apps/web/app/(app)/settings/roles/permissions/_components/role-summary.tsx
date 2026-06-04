"use client";

import {
  CheckCircleIcon,
  EyeIcon,
  MinusCircleIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import {
  type Permission,
  PERMISSION_DOMAINS,
  PERMISSION_META,
  type PermissionDomain,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";

interface RoleSummaryProps {
  /** The edited role's staged permission set. */
  staged: ReadonlySet<Permission>;
}

/** A domain's effective capability level, derived from the staged set. */
type DomainLevel = "edit" | "view" | "none";

/** Derive a domain's level: can it edit (any write/coarse), only view (a read), or nothing? */
function levelFor(
  domain: PermissionDomain,
  staged: ReadonlySet<Permission>,
): DomainLevel {
  let canView = false;
  let canEdit = false;
  for (const p of staged) {
    if (!p.startsWith(`${domain}:`)) continue;
    const tier = PERMISSION_META[p].tier;
    if (tier === "view") canView = true;
    else canEdit = true; // edit / delete / coarse all imply "can change things"
  }
  if (canEdit) return "edit";
  if (canView) return "view";
  return "none";
}

/** Icon + tint per level; the visible label is translated at render via
 * `settings.roles.permissions.summary.levels.<level>`. */
const LEVEL_META: Record<
  DomainLevel,
  { icon: typeof EyeIcon; className: string }
> = {
  edit: {
    icon: PencilSquareIcon,
    className: "text-emerald-700 dark:text-emerald-500",
  },
  view: {
    icon: EyeIcon,
    className: "text-foreground/80",
  },
  none: {
    icon: MinusCircleIcon,
    className: "text-muted-foreground",
  },
};

/**
 * The live "What this role can do" summary, regenerated from the staged set on every edit. For each
 * domain it shows whether the role can View & edit, View only, or Cannot access — the plain-English
 * read-out of the staged permissions, so an admin sees the OUTCOME of their toggles without reading
 * `domain:action` literals. Mirrors the staged (not the saved) set, so it previews exactly what Save
 * will persist.
 */
export function RoleSummary({ staged }: RoleSummaryProps) {
  const t = useTranslations("settings");
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <CheckCircleIcon className="size-4 text-muted-foreground" />
        {t("roles.permissions.summary.heading")}
      </h3>
      <ul className="divide-y rounded-lg border text-sm">
        {PERMISSION_DOMAINS.map((domain) => {
          const level = levelFor(domain, staged);
          const lm = LEVEL_META[level];
          const Icon = lm.icon;
          return (
            <li
              key={domain}
              className="flex items-center justify-between gap-3 px-3 py-1.5"
            >
              <span>{t(`roles.permissions.summary.domains.${domain}`)}</span>
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium ${lm.className}`}
              >
                <Icon className="size-3.5" />
                {t(`roles.permissions.summary.levels.${level}`)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
