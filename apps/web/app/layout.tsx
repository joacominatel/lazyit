import type { Metadata } from "next";
import { Hanken_Grotesk } from "next/font/google";
import localFont from "next/font/local";
import { getLocale, getMessages } from "next-intl/server";
import { auth } from "@/auth";
import { Providers } from "./providers";
import "./globals.css";

// The Ledger type trio (ADR-0077), bound to the CSS variables the shadcn (radix-nova) theme reads
// in globals.css (@theme inline): body/UI = Hanken Grotesk (--font-sans), data/mono = Commit Mono
// (--font-mono), display = Redaction (--font-display, opt-in ONLY on auth + empty-states). Commit
// Mono and Redaction are self-hosted woff2 via next/font/local — neither is on Google Fonts.
const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
});

const commitMono = localFont({
  variable: "--font-mono",
  src: [
    { path: "./fonts/commit-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/commit-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/commit-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
});

const redaction = localFont({
  variable: "--font-display",
  src: [
    { path: "./fonts/redaction-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/redaction-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: {
    default: "lazyit",
    template: "%s · lazyit",
  },
  description:
    "Self-hosted IT asset, access, consumable and knowledge management for small teams.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // i18n cookie-mode (ADR-0051): the active locale and its catalog are resolved per
  // request in `i18n/request.ts` (reads the NEXT_LOCALE cookie). We read them here so
  // the `<html lang>` attribute is correct and the catalog reaches Client Components
  // via the provider tree.
  // Resolve the Auth.js session server-side and seed <SessionProvider> with it so `useSession()`
  // is `authenticated` on the first client render. Without this it starts in `loading`, and the
  // Bearer token isn't in the client store until SessionTokenSync's post-mount effect — leaving a
  // first-paint window where queries fired without an Authorization header and got spurious 401s
  // (issue #498, ADR-0039). Public routes get `null` and behave exactly as before.
  const [locale, messages, session] = await Promise.all([getLocale(), getMessages(), auth()]);

  // suppressHydrationWarning: next-themes sets the theme class on <html> before
  // hydration, which would otherwise trip React's mismatch warning.
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${hankenGrotesk.variable} ${commitMono.variable} ${redaction.variable}`}
    >
      <body className="min-h-svh antialiased">
        <Providers locale={locale} messages={messages} session={session}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
