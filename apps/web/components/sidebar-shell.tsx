"use client";

import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SidebarNav } from "@/components/sidebar-nav";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "sidebar-collapsed";

export function SidebarShell() {
  const t = useTranslations("shared");
  const [collapsed, setCollapsed] = useState(false);

  // localStorage must be read AFTER hydration: SidebarShell is "use client" but it's rendered
  // in the server layout, so it is server-rendered. Reading localStorage in a lazy useState
  // initializer would make the client's first render (collapsed) disagree with the server HTML
  // (expanded) → a hydration mismatch. The effect corrects the state post-mount instead.
  /* eslint-disable react-hooks/set-state-in-effect -- post-hydration localStorage read; a lazy initializer would cause an SSR hydration mismatch */
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") setCollapsed(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-border",
          collapsed ? "justify-center" : "justify-between px-4",
        )}
      >
        {!collapsed && (
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 font-mono text-sm font-semibold tracking-tight"
          >
            {/* ponytail: Ledger wordmark lockup (spec §2b) — mono "lazyit" + the oxblood
                registration tick the favicon abstracts. radius-sm is 6px here, so the 2px tick
                is explicit. Mono (not Redaction, which is reserved for login/empty-states). */}
            lazyit
            <span
              aria-hidden="true"
              className="size-1.5 rounded-[2px] bg-primary"
            />
          </Link>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-pressed={collapsed}
          aria-label={
            collapsed
              ? t("chrome.expandSidebar")
              : t("chrome.collapseSidebar")
          }
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {collapsed ? (
            <ChevronDoubleRightIcon className="size-4" />
          ) : (
            <ChevronDoubleLeftIcon className="size-4" />
          )}
        </button>
      </div>
      <SidebarNav collapsed={collapsed} />
    </aside>
  );
}
