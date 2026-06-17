import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { ReactNode } from "react";

import { PublicLocaleSwitcher } from "@/components/public-locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

const GITHUB_URL = "https://github.com/joacominatel/lazyit";

// Public marketing shell: header + rich footer, no auth. Carries the public language switcher
// (ADR-0062 / ADR-0051) so login-free visitors of the landing AND the Help/Manual surface can
// switch en/es, plus a Manual entry point into the public product documentation. All copy is
// localized via the `marketing` namespace.
export default async function MarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getTranslations("marketing");

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur-sm">
        <Link
          href="/"
          className="font-mono text-base font-semibold tracking-tight"
        >
          lazyit
        </Link>
        <nav className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/help">{t("nav.manual")}</Link>
          </Button>
          <PublicLocaleSwitcher />
          <ThemeToggle />
          <Button size="sm" asChild>
            <Link href="/login">{t("nav.signIn")}</Link>
          </Button>
        </nav>
      </header>

      <main className="flex flex-1 flex-col">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Link
              href="/"
              className="font-mono text-base font-semibold tracking-tight"
            >
              lazyit
            </Link>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              {t("footer.tagline")}
            </p>
          </div>

          <FooterGroup title={t("footer.groupProduct")}>
            <FooterLink href="/help">{t("footer.manual")}</FooterLink>
          </FooterGroup>

          <FooterGroup title={t("footer.groupStart")}>
            <FooterLink href="/setup">{t("footer.setup")}</FooterLink>
            <FooterLink href="/login">{t("footer.signIn")}</FooterLink>
          </FooterGroup>

          <FooterGroup title={t("footer.groupProject")}>
            <FooterLink href={GITHUB_URL} external>
              {t("footer.github")}
            </FooterLink>
          </FooterGroup>
        </div>

        <div className="border-t border-border">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>{t("footer.rights")}</span>
            <span>{t("footer.note")}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium tracking-wide text-foreground uppercase">
        {title}
      </p>
      <ul className="mt-3 space-y-2">{children}</ul>
    </div>
  );
}

function FooterLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  const className =
    "text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";
  return (
    <li>
      {external ? (
        <a href={href} target="_blank" rel="noreferrer" className={className}>
          {children} ↗
        </a>
      ) : (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
    </li>
  );
}
