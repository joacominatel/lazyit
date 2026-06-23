"use client";

import { ServerStackIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";

/**
 * The "no nodes yet" surface for the topology canvas (ADR-0070 §6). A friendly invitation with no
 * inline CTA: the primary "Add node" action (issue #742) lives in the page header (always visible to
 * callers with `infra:manage`), so this stays a calm placeholder rather than duplicating the button.
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
