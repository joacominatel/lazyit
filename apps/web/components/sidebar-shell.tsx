"use client";

import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SidebarNav } from "@/components/sidebar-nav";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "sidebar-collapsed";

export function SidebarShell() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") setCollapsed(true);
  }, []);

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
            className="text-sm font-semibold tracking-tight"
          >
            lazyit
          </Link>
        )}
        <button
          onClick={toggle}
          title={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
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
