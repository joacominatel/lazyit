"use client";

import {
  BellAlertIcon,
  ChevronRightIcon,
  KeyIcon,
  PuzzlePieceIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { ComponentType } from "react";
import { UserRoleBadge } from "@/app/(app)/users/_components/user-role-badge";
import { DetailField, DetailPanel } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import { useAiStatus } from "@/lib/api/hooks/use-ai-status";
import { useCurrentUser } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { AccountPreferencesPanel } from "./account-preferences-panel";
import { AccountSecurityPanel } from "./account-security-panel";

type HubCardKey = "profile" | "notifications" | "ai" | "secrets";

interface HubCard {
  key: HubCardKey;
  href: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * `/account` — the account hub (issue #1404). The signed-in user's own "me": who they are, and a
 * way into every per-user surface that already exists. It adds NO capability of its own — every card
 * links to a page that already exists, and every panel reuses an existing read or action:
 *
 * - **Identity** — `GET /users/me` (open to every signed-in human).
 * - **Cards** — My profile (`/profile`, #947), Notification emails (`/account/notifications`, #879),
 *   AI & connected apps (`/account/ai`, ADR-0097; `ai:connect` + a live `GET /ai/status`, the user-menu
 *   rule), Secret Manager (`/secrets`, `secret:read`) where the personal vault password lives.
 * - **Security** — who owns the password (`GET /config/status` `authMode`) and the existing sign-out.
 * - **Preferences** — the language cookie (ADR-0051) and the theme (next-themes), both client-side.
 *
 * The UI gates only what it draws; the API is the real gate.
 */
export function AccountHubView() {
  const t = useTranslations("account.hub");
  const { date } = useFormatters();
  const locale = useLocale();
  const { data: user, isPending, isError, error, refetch } = useCurrentUser();
  const { can } = useMyPermissions();
  const aiStatus = useAiStatus();

  const cards: HubCard[] = [
    { key: "profile", href: "/profile", icon: UserCircleIcon },
    { key: "notifications", href: "/account/notifications", icon: BellAlertIcon },
  ];
  if (can("ai:connect") && aiStatus.isSuccess) {
    cards.push({ key: "ai", href: "/account/ai", icon: PuzzlePieceIcon });
  }
  if (can("secret:read")) {
    cards.push({ key: "secrets", href: "/secrets", icon: KeyIcon });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : isError || !user ? (
        <ErrorState
          title={t("identity.errorTitle")}
          description={t("identity.errorDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : (
        <DetailPanel
          title={t("identity.title")}
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link href="/profile">{t("identity.viewProfile")}</Link>
            </Button>
          }
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <UserAvatar
              size="lg"
              firstName={user.firstName}
              lastName={user.lastName}
              email={user.email}
            />
            <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <DetailField label={t("identity.name")}>
                {`${user.firstName} ${user.lastName}`.trim() || "—"}
              </DetailField>
              <DetailField label={t("identity.email")}>
                <span className="break-all">{user.email}</span>
              </DetailField>
              <DetailField label={t("identity.role")}>
                {user.role ? <UserRoleBadge role={user.role} /> : "—"}
              </DetailField>
              <DetailField label={t("identity.joined")} mono>
                {date(user.createdAt)}
              </DetailField>
            </dl>
          </div>
        </DetailPanel>
      )}

      <section aria-labelledby="account-hub-sections" className="space-y-3">
        <h2 id="account-hub-sections" className="text-sm font-semibold">
          {t("sections.title")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {cards.map(({ key, href, icon: Icon }) => (
            <Link
              key={key}
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
                    <p className="font-medium">{t(`sections.${key}.title`)}</p>
                    <p className="text-sm text-muted-foreground">
                      {t(`sections.${key}.description`)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <AccountSecurityPanel />

      {/* Keyed on the locale so the picker re-reads it after the refresh a language change triggers. */}
      <AccountPreferencesPanel key={locale} />
    </div>
  );
}
