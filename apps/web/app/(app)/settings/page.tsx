"use client";

import {
  ChevronRightIcon,
  KeyIcon,
  ServerStackIcon,
  TagIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ComponentType } from "react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AdminGate } from "./_components/admin-gate";

interface SettingsSection {
  href: string;
  /** The `hub` subkey holding this section's `title` / `description`. */
  key: "taxonomies" | "roles" | "serviceAccounts" | "instance";
  icon: ComponentType<{ className?: string }>;
}

/**
 * The Settings index — the discoverable home for the admin surfaces: taxonomy management, the role
 * overview, service accounts and instance config. Each card links into its sub-area.
 */
const SECTIONS: SettingsSection[] = [
  { href: "/settings/taxonomies", key: "taxonomies", icon: TagIcon },
  { href: "/settings/roles", key: "roles", icon: UsersIcon },
  {
    href: "/settings/service-accounts",
    key: "serviceAccounts",
    icon: KeyIcon,
  },
  { href: "/settings/instance", key: "instance", icon: ServerStackIcon },
];

export default function SettingsPage() {
  const t = useTranslations("settings");
  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("hub.title")}
          subtitle={t("hub.subtitle")}
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SECTIONS.map(({ href, key, icon: Icon }) => (
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
