import {
  Cog6ToothIcon,
  MapPinIcon,
  ServerStackIcon,
  Squares2X2Icon,
  TicketIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";

// Dummy navigation. Most targets are placeholders that don't exist yet — only
// /dashboard is implemented; the rest land here as the domain is built out.
const NAV = [
  { label: "Dashboard", href: "/dashboard", icon: Squares2X2Icon },
  { label: "Assets", href: "/assets", icon: ServerStackIcon },
  { label: "Tickets", href: "/tickets", icon: TicketIcon },
  { label: "Users", href: "/users", icon: UsersIcon },
  { label: "Locations", href: "/locations", icon: MapPinIcon },
  { label: "Settings", href: "/settings", icon: Cog6ToothIcon },
] as const;

// Private app shell: sidebar + topbar.
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
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            lazyit
          </Link>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Icon className="size-5" />
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end gap-1 border-b border-border px-4">
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
