"use client";

import { Bars3Icon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SidebarNav } from "@/components/sidebar-nav";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Mobile navigation: a `md:hidden` hamburger in the topbar that opens a left
 * Sheet containing the same {@link SidebarNav} used by the desktop rail, so the
 * app is fully navigable below 768px (the desktop sidebar is `hidden md:flex`).
 *
 * The trigger is a 44px tap target (`size-11`, well over the WCAG 2.5.5 minimum)
 * and the sheet closes on navigation — Next App Router doesn't unmount the layout
 * between routes, so we watch the pathname and dismiss on change.
 */
export function MobileNav() {
  const t = useTranslations("shared");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the sheet after a navigation so the next page isn't hidden behind it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 md:hidden"
          aria-label={t("chrome.openNavigationMenu")}
        >
          <Bars3Icon className="size-6" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-0 sm:max-w-xs">
        <SheetHeader className="h-14 justify-center border-b border-border px-4">
          <SheetTitle asChild>
            <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
              lazyit
            </Link>
          </SheetTitle>
        </SheetHeader>
        <SidebarNav />
      </SheetContent>
    </Sheet>
  );
}
