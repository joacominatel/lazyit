import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { GlobalSearch } from "@/components/global-search";
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

  return (
    <div className="flex min-h-svh">
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
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        {/* Syncs Auth.js access token into the client-side store so apiFetch sends Bearer automatically. */}
        <SessionTokenSync />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
