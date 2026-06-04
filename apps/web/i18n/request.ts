import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "./config";

/**
 * Per-request next-intl configuration (ADR-0051). Cookie-mode, no i18n routing: the
 * active locale comes from the `NEXT_LOCALE` cookie, defaulting to `en` when the
 * cookie is absent or holds an unsupported value. This file is referenced by the
 * `createNextIntlPlugin` wrap in `next.config.ts`.
 *
 * The whole `messages/<locale>.json` catalog is loaded here and handed to Server
 * Components (via `getTranslations`) and to Client Components (via the messages we
 * pass into `NextIntlClientProvider` in `app/providers.tsx`).
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieValue = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieValue) ? cookieValue : defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
