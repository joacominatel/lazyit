import Link from "next/link";
import { GlobalSearch } from "@/components/global-search";
import { SidebarNav } from "@/components/sidebar-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { UserSwitcher } from "@/components/user-switcher";

// Private app shell: sidebar + topbar. The interactive nav (active state) lives
// in the SidebarNav client component so this layout stays a server component.
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // TODO: auth guard once IdP is integrated (deferred — see ADR-0016).
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
            <UserSwitcher />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
