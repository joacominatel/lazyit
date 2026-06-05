"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import {
  defaultLocale,
  isLocale,
  LOCALE_COOKIE,
  type Locale,
} from "@/i18n/config";
import enShared from "@/messages/en/shared.json";
import esShared from "@/messages/es/shared.json";
import "./globals.css";

/**
 * Root-level error boundary. Next renders this only when the root layout itself
 * (or a provider it mounts) throws — it replaces the whole document, so it must
 * supply its own <html>/<body> and CANNOT depend on the layout's providers or
 * theme (the `NextIntlClientProvider` from `app/providers.tsx` is gone). Segment
 * errors are handled by the nested (app)/error.tsx instead.
 *
 * i18n (#204): because the layout provider is unavailable here, this boundary
 * wires its OWN `NextIntlClientProvider` — it reads the `NEXT_LOCALE` cookie
 * client-side and supplies just the `shared` catalog for that locale (both
 * locales' `shared.json` are statically imported so the render stays synchronous;
 * the strings shown are `shared.errors.global*`).
 */

/** Only the `shared` catalogs are needed here — the boundary renders nothing else. */
const SHARED_BY_LOCALE: Record<Locale, typeof enShared> = {
  en: enShared,
  es: esShared,
};

/** Read the active locale from the `NEXT_LOCALE` cookie (client-side), falling back to `en`. */
function readLocaleFromCookie(): Locale {
  if (typeof document === "undefined") return defaultLocale;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${LOCALE_COOKIE}=`));
  const value = match?.slice(LOCALE_COOKIE.length + 1);
  return isLocale(value) ? value : defaultLocale;
}

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

  // Resolve once on mount — the cookie can't change while this boundary is shown.
  const locale = useMemo(readLocaleFromCookie, []);
  const messages = useMemo(() => ({ shared: SHARED_BY_LOCALE[locale] }), [
    locale,
  ]);

  return (
    <html lang={locale}>
      <body className="min-h-svh antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <GlobalErrorContent digest={error.digest} reset={reset} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

function GlobalErrorContent({
  digest,
  reset,
}: {
  digest?: string;
  reset: () => void;
}) {
  const t = useTranslations("shared.errors");
  return (
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
            {t("globalTitle")}
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("globalDescription")}
            {digest ? ` ${t("globalReference", { digest })}` : ""}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t("tryAgain")}
      </button>
    </main>
  );
}
