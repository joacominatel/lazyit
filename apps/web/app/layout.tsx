import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getLocale, getMessages } from "next-intl/server";
import { Providers } from "./providers";
import "./globals.css";

// Geist is bound to --font-sans / --font-geist-mono to match the CSS variables
// the shadcn (radix-nova) theme expects in globals.css (@theme inline).
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "lazyit",
    template: "%s · lazyit",
  },
  description:
    "Self-hosted IT asset, access, ticket and knowledge management for small teams.",
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
  const locale = await getLocale();
  const messages = await getMessages();

  // suppressHydrationWarning: next-themes sets the theme class on <html> before
  // hydration, which would otherwise trip React's mismatch warning.
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-svh antialiased">
        <Providers locale={locale} messages={messages}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
