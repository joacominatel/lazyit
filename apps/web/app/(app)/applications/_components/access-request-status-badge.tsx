"use client";

import type { AccessRequestStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import {
  StatusBadge,
  type StatusTone,
} from "@/components/ui/status-badge";

/** Map each request lifecycle status to a status tone (ADR-0077's five-tone system). */
const TONE_BY_STATUS: Record<AccessRequestStatus, StatusTone> = {
  PENDING: "warning",
  APPROVED: "success",
  DENIED: "danger",
};

/**
 * The status pill for an AccessRequest, shared by the admin queue and the requester's profile
 * tracking list so "pending = amber / approved = green / denied = red" reads identically everywhere.
 * Labels come from the `applications.requests.status.*` catalog (the request lifecycle is an
 * applications-domain concept).
 */
export function AccessRequestStatusBadge({
  status,
}: {
  status: AccessRequestStatus;
}) {
  const t = useTranslations("applications");
  return (
    <StatusBadge tone={TONE_BY_STATUS[status]}>
      {t(`requests.status.${status}`)}
    </StatusBadge>
  );
}
