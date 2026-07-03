import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getConfigStatus } from "@/lib/api/endpoints/config";

import { ResetPasswordForm } from "./reset-password-form";

/**
 * `/reset-password?token=…` — public page that consumes the single-use token from the emailed link and
 * sets a new password (ADR-0086 §F4b, local mode). On success the user is routed to /login to sign in
 * with the new password.
 *
 * Gated to local mode (redirect to /login otherwise, config read fails safe to OIDC) so the OIDC path
 * is byte-identical. A missing token renders a clear "invalid link" state with a route back to request
 * a fresh one, rather than a broken form.
 */
async function isLocalMode(): Promise<boolean> {
  try {
    const status = await getConfigStatus();
    return status.authMode === "local";
  } catch {
    return false;
  }
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  if (!(await isLocalMode())) {
    redirect("/login");
  }

  const { token } = await searchParams;
  const t = await getTranslations("auth.resetPassword");

  if (!token) {
    return (
      <Card className="w-full animate-rise-in shadow-e2">
        <CardHeader>
          <CardTitle className="font-display">{t("invalidTitle")}</CardTitle>
          <CardDescription>{t("invalidSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm">
            <ExclamationTriangleIcon
              className="size-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <p className="text-foreground">{t("invalidDetail")}</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button asChild variant="outline" className="w-full">
            <Link href="/forgot-password">{t("requestNew")}</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full animate-rise-in shadow-e2">
      <CardHeader>
        <CardTitle className="font-display">{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <ResetPasswordForm token={token} />
    </Card>
  );
}
