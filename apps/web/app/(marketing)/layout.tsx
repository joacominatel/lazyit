import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

// Public marketing shell: simple header + footer, no auth.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center justify-between border-b border-border px-6">
        <Link href="/" className="text-base font-semibold tracking-tight">
          lazyit
        </Link>
        <nav className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard">Dashboard</Link>
          </Button>
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
