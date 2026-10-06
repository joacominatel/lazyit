"use client";

import {
  ArrowPathIcon,
  CheckBadgeIcon,
  ClockIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type { AssetAssignmentWithUser } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { DetailPanel } from "@/components/detail-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { useReleaseAssignment } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";

/**
 * The asset's current owners, in the record page's side column (#1525). Each owner shows the
 * assigned date and the acknowledgement state (ADR-0089 Part B); `Release` closes the assignment
 * (asset:write), and the owner themself gets `Acknowledge receipt` on their own unconfirmed row — the
 * API self-scopes that call regardless of what renders here.
 */
export function AssetOwnersPanel({
  active,
  meId,
  canWrite,
  onAssign,
  onAcknowledge,
}: {
  active: AssetAssignmentWithUser[];
  meId: string | undefined;
  canWrite: boolean;
  onAssign: () => void;
  onAcknowledge: (assignmentId: string) => void;
}) {
  const t = useTranslations("assets.detail");
  const { date } = useFormatters();
  const release = useReleaseAssignment();
  const [releasingId, setReleasingId] = useState<string | null>(null);

  function handleRelease(assignmentId: string) {
    setReleasingId(assignmentId);
    release.mutate(
      { id: assignmentId },
      {
        onSuccess: () => {
          toast.success(t("ownerReleasedToast"));
          setReleasingId(null);
        },
        onError: (error) => {
          notifyError(error, t("releaseError"));
          setReleasingId(null);
        },
      },
    );
  }

  return (
    <DetailPanel
      title={t("ownersTitle")}
      actions={
        canWrite ? (
          <Button size="sm" variant="outline" onClick={onAssign}>
            <UserPlusIcon />
            {t("assignUser")}
          </Button>
        ) : undefined
      }
    >
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noOwners")}</p>
      ) : (
        <ul className="divide-y">
          {active.map((assignment) => {
            const gone = assignment.user.deletedAt != null;
            const canAcknowledge =
              meId === assignment.userId && !assignment.acknowledgedAt && !gone;
            return (
              <li
                key={assignment.id}
                className="flex gap-3 py-3 first:pt-0 last:pb-0"
              >
                <UserAvatar
                  firstName={assignment.user.firstName}
                  lastName={assignment.user.lastName}
                  email={assignment.user.email}
                  className={gone ? "opacity-50 grayscale" : undefined}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={`/users/${assignment.userId}`}
                      className="truncate font-medium hover:underline"
                    >
                      {assignment.user.firstName} {assignment.user.lastName}
                    </Link>
                    {gone && (
                      <Badge variant="outline" className="text-muted-foreground">
                        {t("deactivated")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("assignedOn", { date: date(assignment.assignedAt) })}
                  </p>
                  {assignment.notes ? (
                    <p className="text-xs break-words text-muted-foreground">
                      <span aria-hidden className="font-mono text-muted-foreground/60">
                        {"// "}
                      </span>
                      {assignment.notes}
                    </p>
                  ) : null}
                  {/* The status hue rides the icon only — the caption stays on --muted-foreground so it
                      holds AA (ADR-0049). */}
                  {assignment.acknowledgedAt ? (
                    <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <CheckBadgeIcon className="size-3.5 text-success" aria-hidden />
                      {t("acknowledgedOn", { date: date(assignment.acknowledgedAt) })}
                    </p>
                  ) : (
                    <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <ClockIcon className="size-3.5 text-warning-text" aria-hidden />
                      {t("awaitingAcknowledgement")}
                    </p>
                  )}
                  {canAcknowledge || canWrite ? (
                    <div className="flex flex-wrap gap-2 pt-1.5">
                      {canAcknowledge && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAcknowledge(assignment.id)}
                        >
                          <CheckBadgeIcon />
                          {t("acknowledgeReceipt")}
                        </Button>
                      )}
                      {canWrite && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={canAcknowledge ? undefined : "-ml-2.5"}
                          onClick={() => handleRelease(assignment.id)}
                          disabled={release.isPending}
                        >
                          {releasingId === assignment.id && (
                            <ArrowPathIcon className="animate-spin" />
                          )}
                          {t("release")}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DetailPanel>
  );
}
