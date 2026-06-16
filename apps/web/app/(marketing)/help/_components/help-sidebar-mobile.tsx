"use client";

import { Bars3Icon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { ManualSearchEntry } from "@/lib/manual/search";
import type { ManualCategory } from "@/lib/manual/types";
import { HelpSearch } from "./help-search";

/**
 * The Help sidebar on mobile (ADR-0062): a hamburger trigger (shown below `lg`) that opens a left
 * `Sheet` holding the SAME search + section nav as the desktop rail. Reuses the vendored shadcn
 * `Sheet` (Radix Dialog) the app navigation already uses (`components/mobile-nav.tsx`) — so it's
 * focus-trapped, Escape-dismissable and labelled for free.
 *
 * Closes itself on navigation: the App Router keeps the layout mounted across `/help/<slug>` routes,
 * so we dismiss when the pathname changes. We derive that during render (store the pathname the
 * sheet last reacted to and reset `open` when it differs) rather than in an effect — the React-
 * recommended "adjust state when a prop changes" pattern, which also keeps the sheet closed on the
 * very next render without a flash. `onNavigate` additionally closes it on the click itself.
 */
export function HelpSidebarMobile({
  index,
  categories,
}: {
  index: ManualSearchEntry[];
  categories: ManualCategory[];
}) {
  const t = useTranslations("help");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);

  // A navigation happened → close the sheet. Done in render (not an effect) so the closed state is
  // already applied on the same commit the new route renders in.
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    if (open) setOpen(false);
  }

  return (
    <div className="lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            aria-label={t("nav.openMenu")}
          >
            <Bars3Icon className="size-5" />
            {t("nav.browse")}
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-80 gap-0 p-0 sm:max-w-sm">
          <SheetHeader className="h-14 justify-center border-b border-border px-4">
            <SheetTitle className="text-sm font-semibold tracking-tight">
              {t("nav.title")}
            </SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto p-4">
            <HelpSearch
              index={index}
              categories={categories}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
