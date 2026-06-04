"use client";

import {
  isServer,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { AbstractIntlMessages } from "next-intl";
import { NextIntlClientProvider } from "next-intl";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";

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
}: {
  children: React.ReactNode;
  /** Active locale (cookie-mode, ADR-0051) — resolved server-side in the root layout. */
  locale: string;
  /** The full message catalog for `locale`, forwarded to Client Components. */
  messages: AbstractIntlMessages;
}) {
  const queryClient = getQueryClient();

  return (
    // NextIntlClientProvider wraps everything so any Client Component can call
    // `useTranslations(...)`. Server Components use `getTranslations` directly and
    // don't need this provider.
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SessionProvider>
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
