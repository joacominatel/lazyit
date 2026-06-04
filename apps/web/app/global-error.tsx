"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import "./globals.css";

/**
 * Root-level error boundary. Next renders this only when the root layout itself
 * (or a provider it mounts) throws — it replaces the whole document, so it must
 * supply its own <html>/<body> and cannot depend on the layout's providers or
 * theme. Segment errors are handled by the nested (app)/error.tsx instead.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-svh antialiased">
        <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground">
          <div className="animate-rise-in flex flex-col items-center gap-6">
            <span
              className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive"
              aria-hidden
            >
              <ExclamationTriangleIcon className="size-7" />
            </span>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                Something went wrong
              </h1>
              <p className="max-w-md text-sm text-muted-foreground">
                The application hit an unexpected error and couldn&apos;t
                recover.
                {error.digest ? ` Reference: ${error.digest}.` : ""}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
