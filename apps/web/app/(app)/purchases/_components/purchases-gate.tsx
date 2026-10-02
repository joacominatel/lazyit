"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PermissionGate } from "@/components/permission-gate";

/** Fails closed: nothing under `/purchases` renders without `purchaseOrder:read`. */
export function PurchasesGate({ children }: { children: ReactNode }) {
  const t = useTranslations("purchases.gate");
  return (
    <PermissionGate permission="purchaseOrder:read" title={t("title")} description={t("description")}>
      {children}
    </PermissionGate>
  );
}
