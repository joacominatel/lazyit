"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { isPurchasePage } from "@/lib/purchases/open-purchase";

/**
 * A dialog result step's *Back to purchase* / *Open purchase* link — not rendered on that purchase's own
 * page, where *Done* already returns to it and a link to the page already shown does nothing (#1505,
 * `isPurchasePage`).
 */
export function OpenPurchaseButton({ purchaseId, children }: { purchaseId: string; children: ReactNode }) {
  const pathname = usePathname();
  if (isPurchasePage(pathname, purchaseId)) return null;
  return (
    <Button variant="outline" asChild>
      <Link href={`/purchases/${purchaseId}`}>{children}</Link>
    </Button>
  );
}
