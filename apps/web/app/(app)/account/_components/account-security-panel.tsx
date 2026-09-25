"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useTransition } from "react";
import { useSecretSession } from "@/app/(app)/secrets/_components/secret-session";
import { DetailPanel } from "@/components/detail-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";
import { signOutAndRevoke } from "@/lib/auth/sign-out";
import { passwordOwner } from "../_lib/account-sections";

/**
 * The hub's "Password & sessions" panel (issue #1404). It EXPLAINS and LINKS; it changes no
 * authentication behavior:
 *
 * - **Password** — local mode links to the existing change-password panel on `/profile` (ADR-0086
 *   §F4b); OIDC says the identity provider owns it. An API without `authMode` shows neither.
 * - **Sessions** — the existing sign-out (`signOutAndRevoke`, #1307), exactly what the user menu's Sign
 *   out does, including locking the in-memory secret session first (#512). In local mode that already
 *   ends every session on every device, so the copy says so; in OIDC mode it ends this browser's.
 *
 * There is no per-device session list: the API exposes none (see the PR follow-ups).
 */
export function AccountSecurityPanel() {
  const t = useTranslations("account.hub.security");
  const { data: status, isPending } = useConfigStatus();
  const { lock } = useSecretSession();
  const [signingOut, startSignOut] = useTransition();
  const owner = passwordOwner(status?.authMode);

  function handleSignOut() {
    startSignOut(async () => {
      lock();
      await signOutAndRevoke();
    });
  }

  return (
    <DetailPanel title={t("title")}>
      {isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <div className="divide-y">
          {owner !== "unknown" ? (
            <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">{t("password.title")}</p>
                <p className="text-sm text-muted-foreground">
                  {owner === "lazyit"
                    ? t("password.local")
                    : t("password.identityProvider")}
                </p>
              </div>
              {owner === "lazyit" ? (
                <Button variant="outline" size="sm" asChild className="shrink-0">
                  <Link href="/profile#change-password">
                    {t("password.change")}
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null}
          <div
            className={
              owner !== "unknown"
                ? "flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between"
                : "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
            }
          >
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{t("sessions.title")}</p>
              <p className="text-sm text-muted-foreground">
                {owner === "lazyit"
                  ? t("sessions.local")
                  : owner === "identity-provider"
                    ? t("sessions.identityProvider")
                    : t("sessions.unknown")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={handleSignOut}
              disabled={signingOut}
            >
              {owner === "lazyit"
                ? t("sessions.signOutEverywhere")
                : t("sessions.signOut")}
            </Button>
          </div>
        </div>
      )}
    </DetailPanel>
  );
}
