"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { isPurchasePage } from "@/lib/purchases/open-purchase";

/**
 * A dialog's *Back to purchase* / *Open purchase* action: a link to the purchase, except on that
 * purchase's own page, where it closes the dialog (`onBack`) — a link to the page already shown keeps
 * the dialog open (#1505, `isPurchasePage`).
 */
export function OpenPurchaseButton({
  purchaseId,
  onBack,
  children,
}: {
  purchaseId: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const pathname = usePathname();
  if (isPurchasePage(pathname, purchaseId)) {
    return (
      <Button type="button" variant="outline" onClick={onBack}>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" asChild>
      <Link href={`/purchases/${purchaseId}`}>{children}</Link>
    </Button>
  );
}
