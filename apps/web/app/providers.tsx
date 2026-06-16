"use client";

import {
  isServer,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { Session } from "next-auth";
import type { AbstractIntlMessages } from "next-intl";
import { NextIntlClientProvider } from "next-intl";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { SHARED_FORMATS } from "@/i18n/config";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Avoid an immediate refetch of freshly fetched/prefetched data.
        staleTime: 60 * 1000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  // Server: a fresh client per request. Browser: reuse a single client so the
  // cache survives re-renders and Suspense boundaries.
  if (isServer) return makeQueryClient();
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

export function Providers({
  children,
  locale,
  messages,
  session,
}: {
  children: React.ReactNode;
  /** Active locale (cookie-mode, ADR-0051) — resolved server-side in the root layout. */
  locale: string;
  /** The full message catalog for `locale`, forwarded to Client Components. */
  messages: AbstractIntlMessages;
  /**
   * Server-resolved Auth.js session (from `auth()` in the root layout). Seeding it here makes
   * `useSession()` return `authenticated` on the FIRST client render instead of starting in
   * `loading` and fetching `/api/auth/session` client-side. That closes the first-paint window
   * where SessionTokenSync hadn't yet set the Bearer token and queries fired token-less → 401
   * (issue #498, ADR-0039).
   */
  session: Session | null;
}) {
  const queryClient = getQueryClient();

  return (
    // NextIntlClientProvider wraps everything so any Client Component can call
    // `useTranslations(...)` / `useFormatter(...)`. The shared date/time presets
    // (issue #497) are forwarded here so client formatting matches the server config
    // (`i18n/request.ts`). Server Components use `getTranslations`/`getFormatter`
    // directly and don't need this provider.
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      formats={SHARED_FORMATS}
    >
      <SessionProvider session={session}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Toaster />
          </ThemeProvider>
        </QueryClientProvider>
      </SessionProvider>
    </NextIntlClientProvider>
  );
}
