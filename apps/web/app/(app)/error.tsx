"use client";

import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";

/**
 * Error boundary for the authenticated app segment. Next renders this in place of a page (the
 * sidebar layout stays mounted) when a page throws during render or data load. Recoverable
 * mutation/action errors are handled inline via `notifyError` toasts; this is the last line of
 * defense for the unexpected. When the failure carries an API request id (ADR-0031), it is shown
 * so the user can quote it when reporting.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  useEffect(() => {
    // Surfaced in the browser console for local debugging; the structured server log already holds
    // the full record keyed by the same request id.
    console.error(error);
  }, [error]);

  return (
    <div className="animate-rise-in flex flex-col items-center justify-center gap-4 rounded-xl border bg-card py-16 text-center shadow-e1">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <ExclamationTriangleIcon className="size-6 text-destructive" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Something went wrong</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred while loading this page."}
        </p>
      </div>
      <RequestIdNote requestId={requestId} />
      <Button variant="outline" onClick={reset}>
        <ArrowPathIcon />
        Try again
      </Button>
    </div>
  );
}
