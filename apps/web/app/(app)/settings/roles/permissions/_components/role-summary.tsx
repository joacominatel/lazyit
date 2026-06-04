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

interface RoleSummaryProps {
  /** The edited role's staged permission set. */
  staged: ReadonlySet<Permission>;
}

/** A domain's effective capability level, derived from the staged set. */
type DomainLevel = "edit" | "view" | "none";

/** Friendly domain labels for the summary (the noun, human-cased). */
const DOMAIN_LABELS: Record<PermissionDomain, string> = {
  asset: "Assets",
  application: "Applications",
  accessGrant: "Access grants",
  consumable: "Consumables",
  article: "Knowledge Base",
  location: "Locations",
  assetModel: "Asset models",
  category: "Categories",
  user: "Users",
  dashboard: "Dashboard",
  search: "Search",
  settings: "Settings",
  logs: "Activity logs",
};

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

const LEVEL_META: Record<
  DomainLevel,
  { label: string; icon: typeof EyeIcon; className: string }
> = {
  edit: {
    label: "View & edit",
    icon: PencilSquareIcon,
    className: "text-emerald-700 dark:text-emerald-500",
  },
  view: {
    label: "View only",
    icon: EyeIcon,
    className: "text-foreground/80",
  },
  none: {
    label: "Cannot access",
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
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <CheckCircleIcon className="size-4 text-muted-foreground" />
        What this role can do
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
              <span>{DOMAIN_LABELS[domain]}</span>
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium ${lm.className}`}
              >
                <Icon className="size-3.5" />
                {lm.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
