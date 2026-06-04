import { MapIcon } from "@heroicons/react/24/outline";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Global 404. Next renders this (inside the root layout) for any unmatched route and for
 * `notFound()` calls that aren't caught by a segment-local not-found. Crafted in the Calm
 * Workshop voice (ADR-0049 «Activated Restraint»): a pillar-tinted map glyph in a chip, a warm
 * headline, one line of copy, and a clear way back — settling in with `rise-in` on mount
 * (reduced-motion-safe via the global guard). The "404" stays a quiet mono caption; colour lives
 * only in the decorative ≥24px chip glyph, never in readable text.
 */
export default async function NotFound() {
  const t = await getTranslations("shared");
  return (
    <main
      id="main-content"
      className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <div className="animate-rise-in flex flex-col items-center gap-6">
        <span
          className="flex size-14 items-center justify-center rounded-full bg-pillar-access/10 text-pillar-access"
          aria-hidden
        >
          <MapIcon className="size-7" />
        </span>
        <div className="space-y-2">
          <p className="font-mono text-sm font-medium text-muted-foreground">
            {t("errors.notFoundCaption")}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("errors.notFoundTitle")}
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("errors.notFoundDescription")}
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard">{t("errors.backToDashboard")}</Link>
        </Button>
      </div>
    </main>
  );
}
