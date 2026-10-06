"use client";

import {
  ArrowUpTrayIcon,
  BoltIcon,
  ChevronRightIcon,
  EnvelopeIcon,
  HashtagIcon,
  KeyIcon,
  MapPinIcon,
  ServerStackIcon,
  SignalIcon,
  TagIcon,
  UserGroupIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ComponentType, ReactNode } from "react";
import { AiAssistantIcon } from "@/components/ai/ai-icons";
import { usePointerGlow } from "@/components/ai/use-pointer-glow";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { AdminGate } from "./_components/admin-gate";
import {
  SETTINGS_NAV,
  type SettingsNavKey,
  visibleSettingsNav,
} from "./_lib/settings-nav";

/** One glyph per destination; the list itself (and its gating) comes from `SETTINGS_NAV`. */
const ICONS: Record<SettingsNavKey, ComponentType<{ className?: string }>> = {
  taxonomies: TagIcon,
  locations: MapPinIcon,
  assetTags: HashtagIcon,
  imports: ArrowUpTrayIcon,
  roles: UsersIcon,
  serviceAccounts: KeyIcon,
  email: EnvelopeIcon,
  directory: UserGroupIcon,
  agents: SignalIcon,
  ai: AiAssistantIcon,
  integrations: BoltIcon,
  instance: ServerStackIcon,
};

/** One hub card; `glow` adds the AI assistant's pointer-following gradient (`ai-glow`, #1405). */
function HubCard({ glow, children }: { glow?: boolean; children: ReactNode }) {
  const handlers = usePointerGlow<HTMLDivElement>();
  return (
    <Card
      className={cn("h-full transition-colors group-hover:bg-muted/40", glow && "ai-glow")}
      {...(glow ? handlers : {})}
    >
      {children}
    </Card>
  );
}

// ponytail: skipped from the ADR-0067 server-prefetch rollout — a pure link hub with no list/record
// read to prefetch (the only read is the client `useMyPermissions` per-card gate).
/**
 * The Settings hub — the overview of every admin surface, in the same groups as the side nav the
 * pages below carry (#1533), both built from `SETTINGS_NAV`. Locations and Bulk import link out to
 * their own routes, which did not move.
 */
export default function SettingsPage() {
  const t = useTranslations("settings");
  // Per-card gate (RBAC v2): hide a card the caller can't use even past AdminGate (e.g. Bulk import →
  // `import:run`). Fails closed — while the permission set loads, `can()` is false (issue #639).
  const { can } = useMyPermissions();
  const groups = visibleSettingsNav(SETTINGS_NAV, can);
  return (
    <AdminGate>
      <div className="space-y-8">
        <PageHeader title={t("hub.title")} subtitle={t("hub.subtitle")} />

        {groups.map((group) => (
          <section key={group.key} className="space-y-3">
            <h2 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              {t(`nav.groups.${group.key}`)}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map(({ href, key }) => {
                const Icon = ICONS[key];
                return (
                  <Link
                    key={href}
                    href={href}
                    className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {/* The AI assistant keeps its pointer-following glow (#1405). */}
                    <HubCard glow={key === "ai"}>
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
                    </HubCard>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </AdminGate>
  );
}
