import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Global 404. Next renders this (inside the root layout) for any unmatched route
 * and for `notFound()` calls that aren't caught by a segment-local not-found. Kept
 * deliberately simple — a clear message and a way back to the app.
 */
export default function NotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <p className="font-mono text-sm font-medium text-muted-foreground">404</p>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
      </div>
      <Button asChild>
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </main>
  );
}
