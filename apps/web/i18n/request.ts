import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "./config";

/**
 * Per-request next-intl configuration (ADR-0051). Cookie-mode, no i18n routing: the
 * active locale comes from the `NEXT_LOCALE` cookie, defaulting to `en` when the
 * cookie is absent or holds an unsupported value. This file is referenced by the
 * `createNextIntlPlugin` wrap in `next.config.ts`.
 *
 * The catalog is split one file per top-level namespace under
 * `messages/<locale>/<area>.json` and composed by the per-locale barrel
 * `messages/<locale>/_all.ts` (so the section-translation fan-out can edit
 * disjoint files without collisions — see `docs/04-development/i18n.md`). The
 * assembled catalog is handed to Server Components (via `getTranslations`) and
 * to Client Components (via the messages passed into `NextIntlClientProvider` in
 * `app/providers.tsx`).
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieValue = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieValue) ? cookieValue : defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}/_all`)).default,
  };
});
