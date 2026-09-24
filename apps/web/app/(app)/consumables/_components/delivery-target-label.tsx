"use client";

import type { ConsumableDeliveryTarget } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { resolveDeliveryTarget } from "@/lib/consumables/deliveries";

/**
 * Where a delivery went (ADR-0098), for the consumable's ledger. A live person / asset / location links
 * to its page; an offboarded person or a deleted asset / archived location keeps its name, carries a
 * quiet flag and is not linked (its detail page is gone); a REDACTED target (the viewer cannot read that
 * domain — the API nulled the name) renders a neutral "restricted" line and never the raw id. Renders
 * nothing for an untargeted movement.
 */
export function DeliveryTargetLabel({
  target,
}: {
  target: ConsumableDeliveryTarget | null | undefined;
}) {
  const t = useTranslations("consumables.detail.target");
  const resolved = resolveDeliveryTarget(target);
  if (!resolved) return null;

  if (resolved.state === "redacted") {
    return (
      <span className="text-muted-foreground italic">
        {t(`restricted.${resolved.kind}`)}
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="sr-only">{t(`kind.${resolved.kind}`)}</span>
      {resolved.href ? (
        <Link href={resolved.href} className="truncate hover:underline">
          {resolved.label}
        </Link>
      ) : (
        <span className="truncate">{resolved.label}</span>
      )}
      {resolved.state === "gone" ? (
        <StatusBadge tone="neutral">{t(`gone.${resolved.kind}`)}</StatusBadge>
      ) : null}
    </span>
  );
}
