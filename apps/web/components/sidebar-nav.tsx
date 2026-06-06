"use client";

import {
  BookOpenIcon,
  ClockIcon,
  Cog6ToothIcon,
  CubeIcon,
  KeyIcon,
  MapPinIcon,
  ServerStackIcon,
  Squares2X2Icon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { Permission } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Pillar } from "@/components/pillar-scope";
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
 *   Manage    → Users, Locations, Settings (supporting registries + admin)
 *
 * Every target is an implemented route; dead links (Tickets) stay out per ADR-0016
 * (no ticketing). "Settings" is the ADMIN-only home for instance config, taxonomy
 * management and the role overview — hidden for non-admins (the API also gates it).
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
    items: [{ labelKey: "applications", href: "/applications", icon: KeyIcon }],
  },
  {
    headingKey: "knowledge",
    pillar: "knowledge",
    items: [{ labelKey: "knowledgeBase", href: "/kb", icon: BookOpenIcon }],
  },
  {
    // Reports — the estate-wide activity history (issue #177). `pillar` is omitted so the active
    // item falls back to the brand indigo (no fifth pillar hue). Gated behind the ADMIN-only
    // `logs:read` permission, so the section is invisible to everyone else.
    headingKey: "reports",
    items: [
      {
        labelKey: "informes",
        href: "/informes",
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
      { labelKey: "locations", href: "/locations", icon: MapPinIcon },
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
          {items.map(({ labelKey, href, icon: Icon }) => {
            // Active for the exact route and any nested route (e.g. /assets/:id).
            const active = pathname === href || pathname.startsWith(`${href}/`);
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
