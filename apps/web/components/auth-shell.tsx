import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

/**
 * Shared full-screen shell for the pre-app surfaces — the (auth) group (login) and the first-run
 * `/setup` wizard. Both used to duplicate the `min-h-svh items-center justify-center bg-muted/30 p-4`
 * centering wrapper verbatim; this is the single source of truth so login and the wizard never jump
 * (same vertical rhythm, same wordmark, same theme toggle).
 *
 * Layout: a fixed top bar carrying the typographic "lazyit" wordmark (interim brand — there is no
 * logo asset yet, so we lean on the mono font) and the theme toggle, over a vertically-centered
 * content column. `contentClassName` lets each surface set its own card width (login is narrow,
 * the wizard is wider) without re-implementing the shell.
 */
export function AuthShell({
  children,
  contentClassName,
}: {
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="flex h-16 shrink-0 items-center justify-between px-6">
        <Link
          href="/"
          className="font-mono text-base font-semibold tracking-tight"
        >
          lazyit
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className={cn("w-full max-w-sm", contentClassName)}>{children}</div>
      </main>
    </div>
  );
}
