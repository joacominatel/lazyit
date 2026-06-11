"use client";

import type { ManagerDescriptor } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";

/**
 * Read-only render of a User's resolved `manager` descriptor (ADR-0058). Three shapes:
 *   - a linked lazyit user → a link to their detail page; if `isOffboarded`, a "former manager
 *     (offboarded)" badge sits beside the (non-link) name — never a dangling link to a soft-deleted row;
 *   - an external (free-text) manager → the verbatim name, muted as "external";
 *   - `null` → a muted "no manager".
 *
 * The descriptor is already redaction-safe (display fields only — no manager email/PII), so this never
 * exposes more than the API chose to resolve.
 */
export function ManagerDisplay({
  manager,
}: {
  manager: ManagerDescriptor | null;
}) {
  const t = useTranslations("users.detail.managerField");

  if (manager === null) {
    return <span className="text-muted-foreground">{t("none")}</span>;
  }

  if (manager.type === "external") {
    return (
      <span>
        {manager.name}{" "}
        <span className="text-muted-foreground">· {t("external")}</span>
      </span>
    );
  }

  const name = `${manager.firstName} ${manager.lastName}`;

  // A soft-deleted (offboarded) linked manager: show the name + an honest badge, but NOT a link to a
  // soft-deleted detail route (it would 404). A live manager links to their page.
  if (manager.isOffboarded) {
    return (
      <span className="inline-flex items-center gap-2">
        <span>{name}</span>
        <StatusBadge tone="warning">{t("offboarded")}</StatusBadge>
      </span>
    );
  }

  return (
    <Link href={`/users/${manager.id}`} className="font-medium hover:underline">
      {name}
    </Link>
  );
}
