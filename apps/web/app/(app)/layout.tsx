import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { Breadcrumb } from "@/components/breadcrumb";
import { GlobalSearch } from "@/components/global-search";
import { MobileNav } from "@/components/mobile-nav";
import { ModeBanner } from "@/components/mode-banner";
import { SessionTokenSync } from "@/components/session-token-sync";
import { SidebarNav } from "@/components/sidebar-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";

// Private app shell: sidebar + topbar. The interactive nav (active state) lives
// in the SidebarNav client component so this layout stays a server component.
// Auth guard: belt-and-suspenders alongside middleware.ts (ADR-0039).
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const t = await getTranslations("shared");

  return (
    <div className="flex min-h-svh">
      {/* Skip link: first focusable element, jumps keyboard/AT users past the
          chrome straight to the page content (WCAG 2.4.1). */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {t("chrome.skipToContent")}
      </a>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Link
            href="/dashboard"
            className="text-sm font-semibold tracking-tight"
          >
            lazyit
          </Link>
        </div>
        <SidebarNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b border-border px-4">
          <MobileNav />
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <ModeBanner />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        {/* Syncs Auth.js access token into the client-side store so apiFetch sends Bearer automatically. */}
        <SessionTokenSync />
        {/* Layout-level breadcrumb bar: route-driven, renders nothing on top-level
            pages (e.g. /dashboard). Retires the per-page "Back to X" buttons.
            `data-app-chrome` lets the print stylesheet strip it when a print-document
            (e.g. the Reports/Informes table) owns the page. */}
        <div
          data-app-chrome
          className="border-b border-border px-4 py-2 empty:hidden md:px-6"
        >
          <Breadcrumb />
        </div>
        <main id="main-content" className="flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
