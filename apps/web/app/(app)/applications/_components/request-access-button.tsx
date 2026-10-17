"use client";

import { HandRaisedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useMyGrants } from "@/lib/api/hooks/use-access-grants";
import { useMyAccessRequests } from "@/lib/api/hooks/use-access-requests";
import { RequestAccessDialog } from "./request-access-dialog";

/** The caller's own state on an application (ADR-0085); both reads are self-scope, so a VIEWER gets it too. */
export function RequestAccessButton({ applicationId }: { applicationId: string }) {
  const t = useTranslations("applications.detail");
  const [open, setOpen] = useState(false);
  const grants = useMyGrants();
  const requests = useMyAccessRequests();

  // Wait for both reads so the button never flashes; a failed read falls back to the button.
  if (grants.isPending || requests.isPending) return null;

  const holdsAccess = (grants.data?.items ?? []).some(
    (grant) => grant.applicationId === applicationId && grant.revokedAt === null,
  );
  const hasPending = (requests.data?.items ?? []).some(
    (request) => request.applicationId === applicationId && request.status === "PENDING",
  );

  if (holdsAccess) return <StatusBadge tone="success">{t("youHaveAccess")}</StatusBadge>;
  if (hasPending) return <StatusBadge tone="warning">{t("accessRequested")}</StatusBadge>;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <HandRaisedIcon />
        {t("requestAccess")}
      </Button>
      <RequestAccessDialog open={open} onOpenChange={setOpen} applicationId={applicationId} />
    </>
  );
}
