"use client";

import { BellAlertIcon } from "@heroicons/react/24/outline";
import type { NotificationType } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { notifyError } from "@/lib/api/notify-error";
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from "@/lib/api/hooks/use-notification-preferences";

/**
 * `/account/notifications` — the self-service "Notification emails" page (issue #879). Any authenticated
 * user manages their per-type EMAIL opt-OUT here; the in-app bell is untouched. The list of toggles is
 * SERVER-DRIVEN off `emailableTypes` (never hardcoded) — SMTP config + which triggers can email decide
 * what appears. Semantics are opt-OUT: a switch reads ON ("email me about X") when the type is NOT in
 * `optedOutTypes`; turning it OFF adds the type to the opted-out set. Each toggle auto-saves via a full,
 * idempotent PUT of the whole opted-out set (the app's established settings-toggle pattern — cf. the
 * Settings → Instance update-check switch), optimistic with a rollback + toast on failure.
 */
export function NotificationPreferencesView() {
  const t = useTranslations("account");
  const { data, isLoading, isError, error, refetch } =
    useNotificationPreferences();
  const update = useUpdateNotificationPreferences();

  function onToggle(type: NotificationType, emailOn: boolean) {
    const current = data?.optedOutTypes ?? [];
    // Switch ON = receive email = NOT opted out. OFF = opt out (add to the set).
    const next = emailOn
      ? current.filter((t) => t !== type)
      : current.includes(type)
        ? current
        : [...current, type];
    update.mutate(next, {
      onError: (error) => notifyError(error, t("toast.saveError")),
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={t("notifications.title")}
        subtitle={t("notifications.subtitle")}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("notifications.card.title")}</CardTitle>
          <CardDescription>{t("notifications.card.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-2/3" />
            </div>
          ) : isError || !data ? (
            <ErrorState
              title={t("notifications.error.title")}
              description={t("notifications.error.description")}
              onRetry={() => refetch()}
              error={error}
            />
          ) : data.emailableTypes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <BellAlertIcon
                className="size-8 text-muted-foreground"
                aria-hidden
              />
              <p className="text-sm text-muted-foreground">
                {t("notifications.empty")}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {data.emailableTypes.map((type) => {
                const emailOn = !data.optedOutTypes.includes(type);
                return (
                  <li
                    key={type}
                    className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium">{typeLabel(t, type)}</p>
                      <p className="text-xs text-muted-foreground">
                        {typeDescription(t, type)}
                      </p>
                    </div>
                    <Switch
                      checked={emailOn}
                      onCheckedChange={(next) => onToggle(type, next)}
                      disabled={update.isPending}
                      aria-label={t("notifications.toggleAria", {
                        type: typeLabel(t, type),
                      })}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** i18n keys can't contain dots (next-intl reads them as nesting), so `workflow.manual_task` maps to
 *  the safe key `workflow_manual_task`. Unknown/future server types fall back to a humanized key. */
function safeKey(type: NotificationType): string {
  return type.replace(/\./g, "_");
}

/** Title-case a raw type key as a last-resort label when the catalog has no entry for it. */
function humanize(type: NotificationType): string {
  return type
    .split(/[._]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

type Translator = ReturnType<typeof useTranslations>;

function typeLabel(t: Translator, type: NotificationType): string {
  const key = `types.${safeKey(type)}.label`;
  return t.has(key) ? t(key) : humanize(type);
}

function typeDescription(t: Translator, type: NotificationType): string {
  const key = `types.${safeKey(type)}.description`;
  return t.has(key) ? t(key) : "";
}
