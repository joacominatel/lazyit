import type { Permission } from "@lazyit/shared";

/** The `settings.nav.items` / `settings.hub` subkey for one destination. */
export type SettingsNavKey =
  | "taxonomies"
  | "locations"
  | "assetTags"
  | "imports"
  | "roles"
  | "serviceAccounts"
  | "email"
  | "directory"
  | "agents"
  | "ai"
  | "integrations"
  | "instance";

export interface SettingsNavItem {
  key: SettingsNavKey;
  href: string;
  /**
   * Show only to callers holding this fine-grained permission (RBAC v2). The whole Settings area is
   * already behind `settings:manage`; an item may ALSO need a narrower grant — Bulk import needs
   * `import:run`, the same gate the wizard and the API enforce. Omitted → anyone past the area gate.
   */
  permission?: Permission;
}

export interface SettingsNavGroup {
  /** The `settings.nav.groups` subkey. */
  key: "inventory" | "access" | "integrations" | "system";
  items: readonly SettingsNavItem[];
}

/**
 * Every Settings destination, grouped by what an operator is doing (#1533). The single source for the
 * side nav AND the hub cards, so the two can never list different pages.
 *
 * Locations and Bulk import live outside `/settings` (their routes did not move); they are listed here
 * because this is where an admin looks for them.
 */
export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  {
    key: "inventory",
    items: [
      { key: "taxonomies", href: "/settings/taxonomies" },
      { key: "locations", href: "/locations" },
      { key: "assetTags", href: "/settings/asset-tags" },
      { key: "imports", href: "/imports", permission: "import:run" },
    ],
  },
  {
    key: "access",
    items: [
      { key: "roles", href: "/settings/roles" },
      { key: "serviceAccounts", href: "/settings/service-accounts" },
    ],
  },
  {
    key: "integrations",
    items: [
      { key: "email", href: "/settings/email" },
      { key: "directory", href: "/settings/directory" },
      // Next to Email and Directory rather than under Access (#1174 put it beside Service accounts):
      // the agent policy is an integration the estate reports through, and the "Add a server" wizard
      // that mints its credential is one click away on the Service accounts page.
      { key: "agents", href: "/settings/agents" },
      { key: "ai", href: "/settings/ai" },
      { key: "integrations", href: "/settings/integrations/tasks" },
    ],
  },
  {
    key: "system",
    items: [{ key: "instance", href: "/settings/instance" }],
  },
];

/**
 * The groups a caller may see: items they lack the permission for are dropped, and a group left empty
 * is dropped with them. Fails closed — pass a `can` that answers `false` while permissions load.
 */
export function visibleSettingsNav(
  groups: readonly SettingsNavGroup[],
  can: (permission: Permission) => boolean,
): SettingsNavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.permission || can(item.permission),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * The href of the item the current path belongs to — the longest href that equals the path or is a
 * parent segment of it, so `/settings/roles/permissions` lights up Roles and `/settings/instance-x`
 * lights up nothing. `null` when no item matches (e.g. the hub itself).
 */
export function activeSettingsHref(
  pathname: string,
  groups: readonly SettingsNavGroup[],
): string | null {
  let best: string | null = null;
  for (const group of groups) {
    for (const { href } of group.items) {
      const matches = pathname === href || pathname.startsWith(`${href}/`);
      if (matches && (best === null || href.length > best.length)) best = href;
    }
  }
  return best;
}
