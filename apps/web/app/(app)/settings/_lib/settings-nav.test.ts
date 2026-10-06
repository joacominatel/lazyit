import { describe, expect, test } from "bun:test";
import type { Permission } from "@lazyit/shared";
import {
  activeSettingsHref,
  SETTINGS_NAV,
  visibleSettingsNav,
} from "./settings-nav";

const allowAll = () => true;
const denyAll = () => false;

describe("visibleSettingsNav", () => {
  test("keeps every item for a caller holding every permission", () => {
    const visible = visibleSettingsNav(SETTINGS_NAV, allowAll);
    const count = (groups: typeof visible) =>
      groups.reduce((n, g) => n + g.items.length, 0);
    expect(count(visible)).toBe(count([...SETTINGS_NAV]));
  });

  test("drops Bulk import without import:run, and only that", () => {
    const visible = visibleSettingsNav(SETTINGS_NAV, denyAll);
    const keys = visible.flatMap((g) => g.items.map((i) => i.key));
    expect(keys).not.toContain("imports");
    expect(keys).toContain("taxonomies");
    expect(keys).toContain("email");
  });

  test("drops a group whose every item is gated away", () => {
    const groups = [
      { key: "inventory" as const, items: [{ key: "imports" as const, href: "/imports", permission: "import:run" as Permission }] },
      { key: "system" as const, items: [{ key: "instance" as const, href: "/settings/instance" }] },
    ];
    expect(visibleSettingsNav(groups, denyAll).map((g) => g.key)).toEqual(["system"]);
  });

  test("lists each split-out instance route once", () => {
    const hrefs = SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.href));
    for (const href of ["/settings/email", "/settings/directory", "/settings/asset-tags", "/settings/instance"]) {
      expect(hrefs.filter((h) => h === href)).toHaveLength(1);
    }
  });
});

describe("activeSettingsHref", () => {
  test("matches an exact route", () => {
    expect(activeSettingsHref("/settings/email", SETTINGS_NAV)).toBe("/settings/email");
  });

  test("matches a nested route to its parent item", () => {
    expect(activeSettingsHref("/settings/roles/permissions", SETTINGS_NAV)).toBe("/settings/roles");
    expect(activeSettingsHref("/settings/integrations/tasks/abc", SETTINGS_NAV)).toBe(
      "/settings/integrations/tasks",
    );
  });

  test("does not match a sibling that merely shares a prefix", () => {
    expect(activeSettingsHref("/settings/instance-x", SETTINGS_NAV)).toBeNull();
  });

  test("matches nothing on the hub", () => {
    expect(activeSettingsHref("/settings", SETTINGS_NAV)).toBeNull();
  });
});
