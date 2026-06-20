"use client";

import {
  ArrowUpTrayIcon,
  BoltIcon,
  ChevronRightIcon,
  KeyIcon,
  MapPinIcon,
  ServerStackIcon,
  TagIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { Permission } from "@lazyit/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ComponentType } from "react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { AdminGate } from "./_components/admin-gate";

interface SettingsSection {
  href: string;
  /** The `hub` subkey holding this section's `title` / `description`. */
  key:
    | "taxonomies"
    | "locations"
    | "imports"
    | "roles"
    | "serviceAccounts"
    | "instance"
    | "integrations";
  icon: ComponentType<{ className?: string }>;
  /**
   * Render only for callers holding this fine-grained permission (RBAC v2). The page itself is already
   * AdminGate'd (`settings:manage`); a card may ALSO require a narrower grant — e.g. Bulk import needs
   * `import:run` (the same gate the wizard + API enforce). Omitted → visible to anyone past AdminGate.
   */
  permission?: Permission;
}

/**
 * The Settings index — the discoverable home for the admin surfaces: taxonomy management, the
 * Locations registry, the role overview, service accounts and instance config. Each card links into
 * its sub-area. Locations is reached from here (issue #312) rather than from a top-level sidebar
 * entry — it is a low-traffic registry, so it sits next to Taxonomies under Config. Its card links
 * out to the full /locations page (the route did not move).
 */
const SECTIONS: SettingsSection[] = [
  { href: "/settings/taxonomies", key: "taxonomies", icon: TagIcon },
  { href: "/locations", key: "locations", icon: MapPinIcon },
  // The guided bulk Migrator (ADR-0069) lives here, not the primary nav — an occasional admin action
  // (issue #639). Same `import:run` gate as the wizard; the route stays /imports (no move).
  { href: "/imports", key: "imports", icon: ArrowUpTrayIcon, permission: "import:run" },
  { href: "/settings/roles", key: "roles", icon: UsersIcon },
  {
    href: "/settings/service-accounts",
    key: "serviceAccounts",
    icon: KeyIcon,
  },
  {
    href: "/settings/integrations/tasks",
    key: "integrations",
    icon: BoltIcon,
  },
  { href: "/settings/instance", key: "instance", icon: ServerStackIcon },
];

export default function SettingsPage() {
  const t = useTranslations("settings");
  // Per-card gate (RBAC v2): hide a card the caller can't use even past AdminGate (e.g. Bulk import →
  // `import:run`). Fails closed — while the permission set loads, `can()` is false (issue #639).
  const { can } = useMyPermissions();
  const sections = SECTIONS.filter((s) => !s.permission || can(s.permission));
  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("hub.title")}
          subtitle={t("hub.subtitle")}
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map(({ href, key, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Card className="h-full transition-colors group-hover:bg-muted/40">
                <CardContent className="flex h-full flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
                      <Icon className="size-5" />
                    </div>
                    <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium">{t(`hub.${key}.title`)}</p>
                    <p className="text-sm text-muted-foreground">
                      {t(`hub.${key}.description`)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </AdminGate>
  );
}
