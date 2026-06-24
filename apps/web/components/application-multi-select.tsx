"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  EntityMultiSelect,
  type EntityMultiSelectItem,
} from "@/components/entity-multi-select";
import { useApplications } from "@/lib/api/hooks/use-applications";

/**
 * An application multi-select (issue #213) for the KB list's specific-entity link filter. Applications
 * are a small, curated catalog, so this runs {@link EntityMultiSelect} in **client-filter** mode over
 * the full directory (`useApplications` returns the flat `Application[]`, requesting the hard-max page
 * — ADR-0030 §6). The Application sibling of {@link AssetMultiSelect} (which is server-search because
 * the asset fleet grows unbounded).
 *
 * Fully controlled by `selected` (the chosen application ids) + `onChange`.
 */
export function ApplicationMultiSelect({
  selected,
  onChange,
  className,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const t = useTranslations("kb");
  const { data: applications } = useApplications();

  const items = useMemo<EntityMultiSelectItem[]>(
    () =>
      (applications ?? []).map((application) => ({
        value: application.id,
        label: application.name,
        keywords: application.vendor ? [application.vendor] : undefined,
      })),
    [applications],
  );

  // Quick View (ADR-0072): the eye reads the ALREADY-LOADED list row — zero extra fetch. The row is
  // the full Application (vendor/url/description); the url is gated by isSafeApplicationUrl in the
  // presenter (SEC-008) and rendered as plain text.
  const byId = useMemo(
    () =>
      new Map((applications ?? []).map((application) => [application.id, application])),
    [applications],
  );

  return (
    <EntityMultiSelect
      label={t("filters.applicationLabelName")}
      items={items}
      selected={selected}
      onChange={onChange}
      searchPlaceholder={t("filters.searchApplication")}
      emptyText={t("filters.noApplications")}
      className={className}
      quickView={(rowId) => {
        const application = byId.get(rowId);
        return application ? { entity: "application", data: application } : null;
      }}
    />
  );
}
