"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";

/**
 * Error boundary for the `(auth)` route group (login). Scoped per-segment (ADR-0067 §4) so a failure
 * here renders an in-group recovery surface inside the auth shell instead of falling through to the
 * root boundary. When the failure carries an API request id (ADR-0031) it is shown so the user can
 * quote it when reporting.
 */
export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("shared");
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="animate-rise-in flex flex-col items-center justify-center gap-4 rounded-xl border bg-card py-16 text-center shadow-e1">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <ExclamationTriangleIcon className="size-6 text-destructive" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("errors.boundaryTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.message || t("errors.boundaryDescription")}
        </p>
      </div>
      <RequestIdNote requestId={requestId} />
      <Button variant="outline" onClick={reset}>
        <ArrowPathIcon />
        {t("errors.tryAgain")}
      </Button>
    </div>
  );
}
