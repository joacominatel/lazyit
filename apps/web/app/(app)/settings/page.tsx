"use client";

import {
  ChevronRightIcon,
  KeyIcon,
  ServerStackIcon,
  TagIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import type { ComponentType } from "react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AdminGate } from "./_components/admin-gate";

interface SettingsSection {
  href: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * The Settings index — the discoverable home for the admin surfaces: taxonomy management, the role
 * overview, service accounts and instance config. Each card links into its sub-area.
 */
const SECTIONS: SettingsSection[] = [
  {
    href: "/settings/taxonomies",
    title: "Taxonomies",
    description:
      "Manage the categories that classify assets, applications, consumables and knowledge-base articles — plus asset models.",
    icon: TagIcon,
  },
  {
    href: "/settings/roles",
    title: "Roles",
    description:
      "See who has which RBAC role across the team. Role changes happen in the Users section.",
    icon: UsersIcon,
  },
  {
    href: "/settings/service-accounts",
    title: "Service accounts",
    description:
      "Create and manage non-human API credentials for CI, scripts and integrations — scoped by permission and revocable.",
    icon: KeyIcon,
  },
  {
    href: "/settings/instance",
    title: "Instance",
    description:
      "Review how this lazyit instance is configured — identity provider, setup state and runtime posture.",
    icon: ServerStackIcon,
  },
];

export default function SettingsPage() {
  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title="Settings"
          subtitle="Instance configuration, taxonomy management, roles and service accounts — administrators only."
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SECTIONS.map(({ href, title, description, icon: Icon }) => (
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
                    <p className="font-medium">{title}</p>
                    <p className="text-sm text-muted-foreground">
                      {description}
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
