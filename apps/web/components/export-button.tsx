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
  /** The resource's export route, e.g. `/assets/export`. */
  path: string;
  /** The list's own filter params, from the endpoint module's `…FilterParams`. */
  params: URLSearchParams;
  /** The list's `total` for the same filters. */
  total: number | undefined;
  /** File name stem: `lazyit-<stem>-YYYY-MM-DD.csv`. */
  filename: string;
  /** The list's read permission; without it the button is not rendered. */
  permission: Permission;
  size?: "default" | "sm";
}

export function ExportButton({
  path,
  params,
  total,
  filename,
  permission,
  size,
}: ExportButtonProps) {
  const canRead = useCan(permission);
  return canRead ? (
    <ExportButtonView path={path} params={params} total={total} filename={filename} size={size} />
  ) : null;
}

/** The button without its permission gate. Exported for the render test. */
export function ExportButtonView({
  path,
  params,
  total,
  filename,
  size,
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

  return (
    <Button
      variant="outline"
      size={size}
      onClick={handleClick}
      disabled={busy || block === "empty"}
      title={t("title")}
    >
      <ArrowDownTrayIcon />
      {busy ? t("busy") : t("button")}
    </Button>
  );
}
