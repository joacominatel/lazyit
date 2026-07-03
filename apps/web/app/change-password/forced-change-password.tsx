"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { ChangePasswordForm } from "@/components/change-password-form";
import { SessionTokenSync } from "@/components/session-token-sync";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Client shell for the forced-change wall (ADR-0086 §F4b). Mounts {@link SessionTokenSync} — this route
 * is outside the `(app)` group, which is where that sync normally lives, so without it `apiFetch` would
 * have no Bearer for the (guard-exempt) `POST /auth/change-password`. Renders the shared
 * {@link ChangePasswordForm} in `forced` mode; on success the fresh token is already swapped in, so we
 * send the user to the dashboard (`replace`, not push — the wall must not sit in history) and refresh so
 * the session-aware shell re-renders with the now-cleared flag.
 */
export function ForcedChangePassword() {
  const t = useTranslations("auth.changePassword");
  const router = useRouter();

  return (
    <Card className="w-full animate-rise-in shadow-e2">
      <SessionTokenSync />
      <CardHeader>
        <CardTitle className="font-display">{t("forcedTitle")}</CardTitle>
        <CardDescription>{t("forcedSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChangePasswordForm
          forced
          onSuccess={() => {
            router.replace("/dashboard");
            router.refresh();
          }}
        />
      </CardContent>
    </Card>
  );
}
