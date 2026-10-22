"use client";

import { ArrowDownTrayIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import {
  DATA_EXPORT_ROW_CAP,
  type DataExportFormat,
  type DataExportResource,
  type Permission,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  downloadExport,
  exportBlock,
  exportErrorKind,
  exportFormats,
} from "@/lib/export/export-file";

export interface ExportButtonProps {
  path: string;
  /** The list's own filter params, from the endpoint module's `…FilterParams`. */
  params: URLSearchParams;
  total: number | undefined;
  /** File name stem: `lazyit-<stem>-YYYY-MM-DD.<csv|xlsx>`. */
  filename: string;
  /** The list's read permission; without it the button is not rendered. */
  permission: Permission;
  /**
   * The export's resource. Only a resource in `DATA_EXPORT_XLSX_RESOURCES` turns the button into
   * a CSV / Excel choice (ADR-0103 §11); without one, or for any other, it stays CSV only.
   */
  resource?: DataExportResource;
  size?: "default" | "sm";
}

export function ExportButton({ permission, ...props }: ExportButtonProps) {
  const canRead = useCan(permission);
  return canRead ? <ExportButtonView {...props} /> : null;
}

/** The button without its permission gate. Exported for the render test. */
export function ExportButtonView({
  path,
  params,
  total,
  filename,
  resource,
  size,
}: Omit<ExportButtonProps, "permission">) {
  const t = useTranslations("export");
  const [busy, setBusy] = useState(false);
  const block = exportBlock(total);
  const formats = exportFormats(resource);

  async function handleExport(format: DataExportFormat) {
    if (block === "overCap") {
      toast.warning(t("overCap", { total: total ?? 0, cap: DATA_EXPORT_ROW_CAP }));
      return;
    }
    setBusy(true);
    try {
      await downloadExport(path, params, filename, format);
    } catch (error) {
      const kind = exportErrorKind(error);
      if (kind) toast.error(t(`errors.${kind}`));
      else notifyError(error, t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || block === "empty";

  if (formats.length === 1) {
    return (
      <Button
        variant="outline"
        size={size}
        onClick={() => handleExport("csv")}
        disabled={disabled}
        title={t("title")}
      >
        <ArrowDownTrayIcon />
        {busy ? t("busy") : t("button")}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size} disabled={disabled} title={t("menu.title")}>
          <ArrowDownTrayIcon />
          {busy ? t("busy") : t("menu.button")}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto">
        {formats.map((format) => (
          <DropdownMenuItem key={format} onSelect={() => void handleExport(format)}>
            {t(`menu.formats.${format}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
