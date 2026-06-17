import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { PublicLocaleSwitcher } from "@/components/public-locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

// Public marketing shell: simple header + footer, no auth. Carries the public language switcher
// (ADR-0062 / ADR-0051) so login-free visitors of the landing AND the Help/Manual surface can
// switch en/es, plus a Help entry point into the public product documentation.
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations("help");

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center justify-between border-b border-border px-6">
        <Link
          href="/"
          className="font-mono text-base font-semibold tracking-tight"
        >
          lazyit
        </Link>
        <nav className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/help">{t("nav.title")}</Link>
          </Button>
          <PublicLocaleSwitcher />
          <ThemeToggle />
          <Button size="sm" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </nav>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
      <footer className="border-t border-border px-6 py-6 text-center text-xs text-muted-foreground">
        lazyit — self-hosted IT management for small teams.
      </footer>
    </div>
  );
}
