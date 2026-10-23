"use client";

import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  BellAlertIcon,
  BellSlashIcon,
  EllipsisHorizontalIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useSetInfraNodeRetired,
  useSetInfraNodeSnooze,
} from "@/lib/api/hooks/use-infra-nodes";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { nodeLifecycle, SNOOZE_PRESETS, snoozeUntilFor } from "@/lib/infra/lifecycle";

/** What both pieces below need of a node: the list row, the graph row, the drill-in and the fleet row all carry it. */
export interface LifecycleNode {
  id: string;
  label: string;
  retiredAt?: string | null;
  alertsSnoozedUntil?: string | null;
}

/**
 * The Retired and Snoozed badges (#1701). Renders nothing for an active, unsnoozed node, so a surface
 * can drop it in beside its other badges unconditionally.
 */
export function NodeLifecycleBadges({ node }: { node: Omit<LifecycleNode, "id" | "label"> }) {
  const t = useTranslations("infra.lifecycle");
  const { dateTime } = useFormatters();
  const { retired, snoozedUntil } = nodeLifecycle(node);
  if (!retired && snoozedUntil === null) return null;
  return (
    <>
      {retired ? (
        <Badge
          variant="outline"
          title={node.retiredAt ? t("retiredSince", { at: dateTime(node.retiredAt) }) : undefined}
        >
          <ArchiveBoxArrowDownIcon aria-hidden />
          {t("retired")}
        </Badge>
      ) : null}
      {snoozedUntil !== null ? (
        <Badge variant="outline" title={t("snoozedUntil", { at: dateTime(snoozedUntil) })}>
          <BellSlashIcon aria-hidden />
          {t("snoozed")}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * The Retire / Snooze menu (#1701) — the same actions from the map's drill-in, the review tray and the
 * fleet table. The caller gates it on `infra:manage`; the API also refuses a machine caller.
 *
 * Retiring is one click with an Undo on the toast rather than a confirmation dialog: it deletes
 * nothing, it is reversed by one more click, and the host reversing it by reporting again is the
 * designed behaviour, not an accident.
 */
export function NodeLifecycleMenu({
  node,
  size = "sm",
}: {
  node: LifecycleNode;
  size?: "sm" | "icon-sm";
}) {
  const t = useTranslations("infra.lifecycle");
  const { dateTime } = useFormatters();
  const setRetired = useSetInfraNodeRetired();
  const setSnooze = useSetInfraNodeSnooze();
  const { retired, snoozedUntil } = nodeLifecycle(node);
  const busy = setRetired.isPending || setSnooze.isPending;

  function retire(next: boolean) {
    setRetired.mutate(
      { id: node.id, retired: next },
      {
        onSuccess: () =>
          next
            ? toast.success(t("retiredToast", { label: node.label }), {
                description: t("retiredToastDescription"),
                action: {
                  label: t("undo"),
                  onClick: () => setRetired.mutate({ id: node.id, retired: false }),
                },
              })
            : toast.success(t("unretiredToast", { label: node.label })),
        onError: (error) => notifyError(error, t("error")),
      },
    );
  }

  function snooze(until: string | null) {
    setSnooze.mutate(
      { id: node.id, until },
      {
        onSuccess: () =>
          until === null
            ? toast.success(t("unsnoozedToast", { label: node.label }))
            : toast.success(t("snoozedToast", { label: node.label, at: dateTime(until) })),
        onError: (error) => notifyError(error, t("error")),
      },
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size}
          disabled={busy}
          data-row-noclick
          aria-label={t("menuAria", { label: node.label })}
        >
          <EllipsisHorizontalIcon aria-hidden />
          {size === "sm" ? t("menu") : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[16rem] max-w-[22rem]">
        <DropdownMenuLabel className="truncate">{node.label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {retired ? (
          <DropdownMenuItem onSelect={() => retire(false)}>
            <ArchiveBoxXMarkIcon aria-hidden />
            {t("unretire")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className="items-start" onSelect={() => retire(true)}>
            <ArchiveBoxArrowDownIcon className="mt-0.5" aria-hidden />
            <span className="flex flex-col gap-0.5">
              <span>{t("retire")}</span>
              <span className="text-xs text-muted-foreground">{t("retireHint")}</span>
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {snoozedUntil !== null ? (
          <DropdownMenuItem onSelect={() => snooze(null)}>
            <BellAlertIcon aria-hidden />
            <span className="flex flex-col gap-0.5">
              <span>{t("unsnooze")}</span>
              <span className="text-xs text-muted-foreground">
                {t("snoozedUntil", { at: dateTime(snoozedUntil) })}
              </span>
            </span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <BellSlashIcon aria-hidden />
            {snoozedUntil !== null ? t("snoozeChange") : t("snooze")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {SNOOZE_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset} onSelect={() => snooze(snoozeUntilFor(preset))}>
                {t(`preset.${preset}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
