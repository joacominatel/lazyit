"use client";

import {
  BookOpenIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  CubeIcon,
  KeyIcon,
  LockClosedIcon,
  ServerStackIcon,
  Squares2X2Icon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { Permission } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { Pillar } from "@/components/pillar-scope";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";

type NavItem = {
  /**
   * Key into the `nav` namespace (ADR-0051) — resolved at render via
   * `useTranslations('nav')`. The route/icon stay static; only the visible label is
   * translated.
   */
  labelKey: string;
  href: string;
  icon: typeof Squares2X2Icon;
  /**
   * Render only for callers who can manage settings (`settings:manage`) — the Settings shell. The API
   * still gates the routes server-side; this just hides the link from those who can't use it.
   */
  adminOnly?: boolean;
  /**
   * Render only for callers who hold this fine-grained permission (RBAC v2). The API's
   * `@RequirePermission` guard is still the real gate — this just hides a link the caller can't use
   * (e.g. Reports → `logs:read`, ADMIN-only). Independent of {@link adminOnly}; an item may carry
   * either, both, or neither. Fails closed: while the permission set is loading the item is hidden.
   */
  permission?: Permission;
  /**
   * Mark this item as an expandable nav GROUP (issue #287): the top row still links to/highlights
   * `href`, but it gains a chevron toggle that reveals the live Applications list, each linking to
   * that app's detail page (`/applications/:id`, issue #302). Only the Access → Applications item
   * carries this. Honoured only on the expanded rail (`!collapsed`); the icon-only rail keeps the
   * plain link. The sub-list inherits the item's existing gating (no extra `permission`/`adminOnly`).
   */
  expandable?: boolean;
};

type NavSection = {
  /**
   * Key into the `nav` namespace for the section heading (ADR-0051), or null for the
   * ungrouped top item (Dashboard).
   */
  headingKey: string | null;
  /**
   * The pillar whose hue the section's ACTIVE item wears on its icon (ADR-0049). Omitted for
   * the ungrouped Dashboard, which falls back to the brand indigo (Access hue) — the calm
   * "you're home" tone. The pillar hue only ever colours the (decorative, label-paired) icon;
   * the readable label stays on `--sidebar-accent-foreground`.
   */
  pillar?: Pillar;
  items: NavItem[];
};

/**
 * Static, scanner-safe pillar-icon classes for the ACTIVE nav item. The active icon wears its
 * pillar hue; the brand-indigo `text-primary` is the Dashboard/fallback tone. Active state is
 * never colour alone — it is also a `--muted` bg-tint + a font-weight bump, so the hue is a
 * reinforcement, not the sole signifier. Full strings so the Tailwind v4 scanner keeps them.
 */
const ACTIVE_ICON_BY_PILLAR: Record<Pillar | "default", string> = {
  inventory: "text-pillar-inventory",
  access: "text-pillar-access",
  knowledge: "text-pillar-knowledge",
  manage: "text-pillar-manage",
  default: "text-primary",
};

/**
 * Navigation grouped into the product's three pillars plus a demoted "Manage"
 * section, instead of a flat 7-item list (which contradicted the three-pillars
 * mental model and split Assets from Consumables).
 *
 *   Inventory → Assets, Consumables   (reunited)
 *   Access    → Applications          (the route stays /applications; the
 *                                      section name "Access" is the pillar — this
 *                                      resolves the Access-vs-Applications split:
 *                                      the *thing* is an Application, the *pillar*
 *                                      is Access)
 *   Knowledge → Knowledge Base
 *   Manage    → Users, Settings        (supporting admin)
 *
 * Every target is an implemented route; dead links (Tickets) stay out per ADR-0016
 * (no ticketing). "Settings" is the ADMIN-only home for instance config, taxonomy
 * management and the role overview — hidden for non-admins (the API also gates it).
 * Locations is no longer a top-level nav entry (issue #312): it is a low-traffic
 * registry reached from Settings (the Config → Taxonomies surface), so its card lives
 * in the Settings hub. The page itself still serves at /locations.
 */
const NAV: NavSection[] = [
  {
    headingKey: null,
    items: [
      { labelKey: "dashboard", href: "/dashboard", icon: Squares2X2Icon },
    ],
  },
  {
    headingKey: "inventory",
    pillar: "inventory",
    items: [
      { labelKey: "assets", href: "/assets", icon: ServerStackIcon },
      { labelKey: "consumables", href: "/consumables", icon: CubeIcon },
    ],
  },
  {
    headingKey: "access",
    pillar: "access",
    items: [
      {
        labelKey: "applications",
        href: "/applications",
        icon: KeyIcon,
        expandable: true,
      },
    ],
  },
  {
    headingKey: "knowledge",
    pillar: "knowledge",
    items: [
      { labelKey: "knowledgeBase", href: "/kb", icon: BookOpenIcon },
      { labelKey: "secrets", href: "/secrets", icon: LockClosedIcon },
    ],
  },
  {
    // Reports — the estate-wide activity history (issue #177). `pillar` is omitted so the active
    // item falls back to the brand indigo (no fifth pillar hue). Gated behind the ADMIN-only
    // `logs:read` permission, so the section is invisible to everyone else.
    headingKey: "reports",
    items: [
      {
        labelKey: "reports",
        href: "/reports",
        icon: ClockIcon,
        permission: "logs:read",
      },
    ],
  },
  {
    headingKey: "manage",
    pillar: "manage",
    items: [
      { labelKey: "users", href: "/users", icon: UsersIcon },
      {
        labelKey: "settings",
        href: "/settings",
        icon: Cog6ToothIcon,
        adminOnly: true,
      },
    ],
  },
];

export function SidebarNav({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  // Sidebar labels/headings live in the `nav` namespace (ADR-0051). This is the Phase-0
  // worked example: one real section of the chrome wired through next-intl, proving the
  // plumbing end-to-end before the per-section fan-out extracts the rest.
  const t = useTranslations("nav");
  // Resolve the whole permission set ONCE (rules of hooks: no `useCan` inside the item loop). `can`
  // answers any fine-grained gate (`logs:read`, …); `adminOnly` keeps mapping to `settings:manage`.
  const { can } = useMyPermissions();

  return (
    <nav className={cn("flex-1 overflow-y-auto p-2", collapsed ? "space-y-0.5" : "space-y-4")}>
      {NAV.map((section, index) => {
        // Hide items the caller can't use, then drop a section that empties out:
        //  - `adminOnly`  → needs `settings:manage` (the Settings shell).
        //  - `permission` → needs that fine-grained permission (e.g. Reports → `logs:read`).
        // Fails closed: while the set is loading `can()` is false, so a gated item stays hidden.
        const items = section.items.filter(
          (item) =>
            (!item.adminOnly || can("settings:manage")) &&
            (!item.permission || can(item.permission)),
        );
        if (items.length === 0) return null;
        // The active item's icon wears this section's pillar hue (Dashboard → brand fallback).
        const activeIconClass = ACTIVE_ICON_BY_PILLAR[section.pillar ?? "default"];
        return (
        <div key={section.headingKey ?? `section-${index}`} className="space-y-0.5">
          {/* section heading - hidden when collapsed, a divider line takes its place */}
          {section.headingKey && !collapsed ? (
            <p className="px-3 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
              {t(section.headingKey)}
            </p>
          ) : section.headingKey && collapsed ? (
            <div className="mx-2 my-1 border-t border-border" />
          ) : null}
          {items.map((item) => {
            const { labelKey, href, icon: Icon } = item;
            // Active for the exact route and any nested route (e.g. /assets/:id).
            const active = pathname === href || pathname.startsWith(`${href}/`);
            // The Access → Applications item becomes an expandable group on the expanded rail
            // (issue #287). The icon-only rail keeps the plain link (no room for a sub-tree).
            if (item.expandable && !collapsed) {
              return (
                <ExpandableNavGroup
                  key={href}
                  labelKey={labelKey}
                  href={href}
                  icon={Icon}
                  activeIconClass={activeIconClass}
                />
              );
            }
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                title={collapsed ? t(labelKey) : undefined}
                className={cn(
                  // min-h-11 gives a ~44px tap target on touch; md:min-h-9
                  // restores desktop density on the always-visible rail.
                  "flex min-h-11 items-center rounded-md py-2 text-sm transition-colors md:min-h-9",
                  collapsed ? "justify-center px-0" : "gap-2.5 px-3",
                  active
                    ? // Active reads as tint + weight + a pillar-toned icon — three reinforcing
                      // cues, never colour alone. The readable label stays on the AA-cleared
                      // accent-foreground; only the (label-paired) icon takes the pillar hue.
                      "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className={cn("size-5 shrink-0", active && activeIconClass)} />
                {!collapsed && t(labelKey)}
              </Link>
            );
          })}
        </div>
        );
      })}
    </nav>
  );
}

/** DOM id linking the toggle's `aria-controls` to the revealed Applications sub-list. */
const APPLICATIONS_SUBNAV_ID = "sidebar-applications-subnav";

/**
 * The Access → Applications item rendered as an expandable group (issue #287). The top row keeps the
 * link to the Applications list (`/applications`); an adjacent chevron toggles a sub-tree of the live
 * applications, each routing to that app's detail page (`/applications/:id`, issue #302) — letting an
 * admin jump straight to an application from the nav. Rendered only on the expanded rail; the
 * icon-only rail falls back to the plain link.
 *
 * Active state is two-tier, mirroring the flat items' tint+weight+hue language without two competing
 * full tints: the exact list route (`/applications`) gets the full accent tint; being *inside* the
 * section (an app detail/workflows) keeps the row weighted with the pillar-hued icon (no bg) so the
 * highlighted leaf stands alone. Openness is pure-derived: `null` follows the route (so the group
 * auto-opens whenever you're inside the section), and toggling the chevron pins an explicit choice
 * that sticks until toggled again. A real `<button>` gives Enter/Space and `aria-expanded` for free,
 * with no effect (no cascading-render lint, no open/close flash).
 */
function ExpandableNavGroup({
  labelKey,
  href,
  icon: Icon,
  activeIconClass,
}: {
  labelKey: string;
  href: string;
  icon: typeof Squares2X2Icon;
  activeIconClass: string;
}) {
  const pathname = usePathname();
  const t = useTranslations("nav");
  const sectionActive = pathname === href || pathname.startsWith(`${href}/`);
  const topActive = pathname === href;
  const [userPref, setUserPref] = useState<boolean | null>(null);
  const expanded = userPref ?? sectionActive;

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          "flex min-h-11 items-center rounded-md text-sm transition-colors md:min-h-9",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          topActive
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : sectionActive
              ? "font-medium text-sidebar-accent-foreground"
              : "text-muted-foreground",
        )}
      >
        <Link
          href={href}
          aria-current={topActive ? "page" : undefined}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md py-2 pl-3 md:min-h-9"
        >
          <Icon className={cn("size-5 shrink-0", sectionActive && activeIconClass)} />
          <span className="truncate">{t(labelKey)}</span>
        </Link>
        <button
          type="button"
          onClick={() => setUserPref(!expanded)}
          aria-expanded={expanded}
          aria-controls={APPLICATIONS_SUBNAV_ID}
          aria-label={t(expanded ? "collapseApplications" : "expandApplications")}
          className="mr-1 flex size-9 shrink-0 items-center justify-center rounded-md md:size-7"
        >
          <ChevronRightIcon
            className={cn("size-4 transition-transform", expanded && "rotate-90")}
          />
        </button>
      </div>
      {expanded ? <ApplicationsSubList pathname={pathname} /> : null}
    </div>
  );
}

/**
 * The revealed Applications sub-tree (issue #287). Mounted only while the group is expanded, so the
 * apps query is deferred until first open (and stays cached after). Each app links to its detail page
 * (`/applications/:id`, issue #302); the active app (its detail OR any nested route, e.g. that app's
 * Workflows page) wears the leaf accent tint. Capped with a scroll so a larger directory degrades
 * gracefully — a small team has few apps, so no search.
 */
function ApplicationsSubList({ pathname }: { pathname: string }) {
  const t = useTranslations("nav");
  const { data: applications, isLoading } = useApplications();

  const wrapperClass = "ml-[1.4rem] space-y-0.5 border-l border-border/60 pl-2";

  if (isLoading) {
    return (
      <ul id={APPLICATIONS_SUBNAV_ID} className={wrapperClass}>
        {[0, 1, 2].map((row) => (
          <li key={row} className="px-2 py-2">
            <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
          </li>
        ))}
      </ul>
    );
  }

  const apps = applications ?? [];
  if (apps.length === 0) {
    return (
      <ul id={APPLICATIONS_SUBNAV_ID} className={wrapperClass}>
        <li className="px-2 py-2 text-xs text-muted-foreground">
          {t("noApplications")}
        </li>
      </ul>
    );
  }

  return (
    <ul
      id={APPLICATIONS_SUBNAV_ID}
      className={cn(wrapperClass, "max-h-64 overflow-y-auto")}
    >
      {apps.map((app) => {
        const base = `/applications/${app.id}`;
        const active = pathname === base || pathname.startsWith(`${base}/`);
        return (
          <li key={app.id}>
            <Link
              href={base}
              aria-current={active ? "page" : undefined}
              title={app.name}
              className={cn(
                "flex min-h-9 items-center rounded-md px-2 py-1.5 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <span className="truncate">{app.name}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
