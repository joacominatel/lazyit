"use client";

import { ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { DATA_EXPORT_ROW_CAP, type Permission } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  downloadExport,
  exportBlock,
  exportErrorKind,
} from "@/lib/export/export-file";

export interface ExportButtonProps {
  path: string;
  /** The list's own filter params, from the endpoint module's `…FilterParams`. */
  params: URLSearchParams;
  total: number | undefined;
  /** File name stem: `lazyit-<stem>-YYYY-MM-DD.csv`. */
  filename: string;
  /** The list's read permission; without it the button is not rendered. */
  permission: Permission;
  size?: "default" | "sm";
  /** Set when the screen narrows rows the export cannot: the button is disabled and says why. */
  disabledReason?: string;
}

export function ExportButton({
  path,
  params,
  total,
  filename,
  permission,
  size,
  disabledReason,
}: ExportButtonProps) {
  const canRead = useCan(permission);
  return canRead ? (
    <ExportButtonView
      path={path}
      params={params}
      total={total}
      filename={filename}
      size={size}
      disabledReason={disabledReason}
    />
  ) : null;
}

/** The button without its permission gate. Exported for the render test. */
export function ExportButtonView({
  path,
  params,
  total,
  filename,
  size,
  disabledReason,
}: Omit<ExportButtonProps, "permission">) {
  const t = useTranslations("export");
  const [busy, setBusy] = useState(false);
  const block = exportBlock(total);

  async function handleClick() {
    if (block === "overCap") {
      toast.warning(t("overCap", { total: total ?? 0, cap: DATA_EXPORT_ROW_CAP }));
      return;
    }
    setBusy(true);
    try {
      await downloadExport(path, params, filename);
    } catch (error) {
      const kind = exportErrorKind(error);
      if (kind) toast.error(t(`errors.${kind}`));
      else notifyError(error, t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  const button = (
    <Button
      variant="outline"
      size={size}
      onClick={handleClick}
      disabled={busy || block === "empty" || disabledReason !== undefined}
      title={disabledReason ?? t("title")}
    >
      <ArrowDownTrayIcon />
      {busy ? t("busy") : t("button")}
    </Button>
  );
  // A disabled button gets no pointer events, so the wrapper carries the hover hint.
  return disabledReason ? <span title={disabledReason}>{button}</span> : button;
}
