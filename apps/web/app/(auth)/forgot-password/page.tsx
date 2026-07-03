import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getConfigStatus } from "@/lib/api/endpoints/config";

import { ForgotPasswordForm } from "./forgot-password-form";

/**
 * `/forgot-password` — public reset-request page (ADR-0086 §F4b, local mode). Resolves an email-or-
 * username and asks the API to email a single-use reset link; the confirmation is ALWAYS uniform (no
 * user-enumeration). Reached from the local `/login` screen.
 *
 * Gated to local mode: an OIDC instance delegates credentials to its IdP, so this page redirects to
 * /login there and the OIDC path is byte-identical. The config read fails safe to OIDC (redirect) if
 * the API is unreachable — the page is only meaningful when the API confirms local mode.
 */
async function isLocalMode(): Promise<boolean> {
  try {
    const status = await getConfigStatus();
    return status.authMode === "local";
  } catch {
    return false;
  }
}

export default async function ForgotPasswordPage() {
  if (!(await isLocalMode())) {
    redirect("/login");
  }

  const t = await getTranslations("auth.forgotPassword");

  return (
    <Card className="w-full animate-rise-in shadow-e2">
      <CardHeader>
        <CardTitle className="font-display">{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <ForgotPasswordForm />
    </Card>
  );
}
