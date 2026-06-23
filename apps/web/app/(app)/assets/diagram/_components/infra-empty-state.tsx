"use client";

import { ServerStackIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";

/**
 * The "no nodes yet" surface for the topology canvas (ADR-0070 §6, issue #741). The create flow
 * (and so the primary action) is issue #742, so this is a friendly invitation without a CTA button
 * for now — it points the operator at where node-creation will live once #742 lands.
 *
 * ponytail: reuses the app-wide `EmptyState` (inventory pillar, matching the Assets section) rather
 * than a bespoke canvas placeholder.
 */
export function InfraEmptyState() {
  const t = useTranslations("infra");
  return (
    <div className="flex size-full items-center justify-center">
      <EmptyState
        icon={ServerStackIcon}
        pillar="inventory"
        title={t("empty.title")}
        description={t("empty.description")}
        className="max-w-md"
      />
    </div>
  );
}
