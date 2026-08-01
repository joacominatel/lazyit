"use client";

import type { AgentReport } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { DetailField, DetailPanel } from "@/components/detail-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { formatFieldLabel, formatSpecValue } from "@/lib/utils/format";

type AgentHost = AgentReport["host"];
type AgentSoftware = NonNullable<AgentReport["software"]>;

/**
 * The subset of an `Asset.specs` blob that an ADR-0074 reporting agent lands on a confirmed host:
 * the `host` facts, an optional `software` list and the report timestamp. `extras` collects any other
 * (human-added) custom fields so they still render — the internal `_infraAutoCreated` marker is dropped.
 */
export interface AgentInventory {
  host: AgentHost;
  software?: AgentSoftware;
  reportedAt?: string;
  extras: Array<[string, unknown]>;
}

/**
 * Keys the structured panels own — everything else falls through to the custom-fields grid.
 *
 * `diagnostics` and `agentSkew` (#1138) are listed here to be EXCLUDED, not rendered. They ride the
 * NODE's blob (never an Asset's — the API strips them on both Asset-facing paths), and they are
 * machine bookkeeping about a single check-in: what the collector could not do, and what this build
 * could not understand about the report. Dumping them under "Custom fields" would put a raw JSON blob
 * on the panel of every host that merely reports unprivileged, labelled as if a human had typed it.
 * They stay out until a surface is designed for them (the fleet view).
 */
const INVENTORY_KEYS = new Set([
  "host",
  "software",
  "reportedAt",
  "_infraAutoCreated",
  "diagnostics",
  "agentSkew",
]);

/**
 * Lightweight shape check (ADR-0074 §2): an agent-reported asset carries a nested `host` object with a
 * `hostname` — regular custom fields are flat scalars, so a nested `host` is the signal. Returns the
 * typed inventory (consuming the shared `AgentReport` type) or `null` to fall back to the raw render.
 */
export function getAgentInventory(
  specs: Record<string, unknown> | null | undefined,
): AgentInventory | null {
  if (!specs) return null;
  const host = specs.host;
  if (!host || typeof host !== "object" || Array.isArray(host)) return null;
  if (typeof (host as Record<string, unknown>).hostname !== "string") return null;

  const software = Array.isArray(specs.software)
    ? (specs.software as AgentSoftware)
    : undefined;
  const reportedAt =
    typeof specs.reportedAt === "string" ? specs.reportedAt : undefined;
  const extras = Object.entries(specs).filter(
    ([key]) => !INVENTORY_KEYS.has(key),
  );

  return { host: host as AgentHost, software, reportedAt, extras };
}

/** Bytes → a compact human size ("512 GB", "31.4 GB"). Non-positive/NaN yields "—". */
function formatBytes(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/**
 * A structured, read-only render of ADR-0074 agent inventory carried in `Asset.specs` — the Host facts
 * panel plus a searchable/collapsible Software list. Replaces the raw-JSON custom-fields dump for
 * agent-reported assets; humans don't edit these facts (the agent owns them).
 */
export function AgentInventoryPanel({ inventory }: { inventory: AgentInventory }) {
  const t = useTranslations("assets.detail.inventory");
  const tc = useTranslations("common");
  const tf = useTranslations("assets.detail");
  const { date } = useFormatters();
  const { host, software, reportedAt, extras } = inventory;

  const disks = host.disks ?? [];
  const nics = host.nics ?? [];

  // Host key-value rows — each entry omitted when its source field is missing (graceful partials).
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
  if (host.os?.name) rows.push({ label: t("os"), value: host.os.name });
  if (host.os?.version)
    rows.push({ label: t("osVersion"), value: host.os.version, mono: true });
  if (host.os?.kernel)
    rows.push({ label: t("kernel"), value: host.os.kernel, mono: true });
  if (host.cpu?.model) rows.push({ label: t("cpu"), value: host.cpu.model });
  if (host.cpu?.cores != null)
    rows.push({ label: t("cores"), value: String(host.cpu.cores), mono: true });
  if (host.memoryBytes != null)
    rows.push({ label: t("memory"), value: formatBytes(host.memoryBytes), mono: true });
  if (host.hardware?.manufacturer)
    rows.push({ label: t("manufacturer"), value: host.hardware.manufacturer });
  if (host.hardware?.model)
    rows.push({ label: t("hardwareModel"), value: host.hardware.model });
  if (host.hardware?.serial)
    rows.push({ label: t("serial"), value: host.hardware.serial, mono: true });

  return (
    <>
      <DetailPanel
        title={t("hostTitle")}
        actions={
          reportedAt ? (
            <span className="text-xs text-muted-foreground">
              {t("reportedAt", { date: date(reportedAt) })}
            </span>
          ) : undefined
        }
      >
        {rows.length > 0 ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            {rows.map((row) => (
              <DetailField key={row.label} label={row.label} mono={row.mono}>
                {row.value}
              </DetailField>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noHostFacts")}</p>
        )}

        {disks.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("disksTitle")}
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("device")}</TableHead>
                  <TableHead>{t("size")}</TableHead>
                  <TableHead>{t("mount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {disks.map((disk, i) => (
                  <TableRow key={`${disk.device}-${i}`}>
                    <TableCell className="font-mono">{disk.device}</TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {formatBytes(disk.sizeBytes)}
                    </TableCell>
                    <TableCell className="font-mono">{disk.mountpoint ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {nics.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("nicsTitle")}
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("interface")}</TableHead>
                  <TableHead>{t("mac")}</TableHead>
                  <TableHead>{t("ipv4")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nics.map((nic, i) => (
                  <TableRow key={`${nic.name}-${i}`}>
                    <TableCell className="font-mono">{nic.name}</TableCell>
                    <TableCell className="font-mono">{nic.mac ?? "—"}</TableCell>
                    <TableCell className="font-mono">
                      {nic.ipv4 && nic.ipv4.length > 0 ? nic.ipv4.join(", ") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {extras.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {tf("customFieldsTitle")}
            </h3>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {extras.map(([key, value]) => (
                <div key={key} className="space-y-1">
                  <dt className="text-xs font-medium text-muted-foreground">
                    {formatFieldLabel(key) || key}
                  </dt>
                  <dd className="text-sm break-words">
                    {formatSpecValue(value, { yes: tc("yes"), no: tc("no") })}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </DetailPanel>

      {software !== undefined && <SoftwarePanel software={software} />}
    </>
  );
}

/** Searchable + collapsible installed-package list — a count, a filter and expand-on-demand rows. */
function SoftwarePanel({ software }: { software: AgentSoftware }) {
  const t = useTranslations("assets.detail.inventory");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return software;
    return software.filter((pkg) => pkg.name.toLowerCase().includes(q));
  }, [software, query]);

  return (
    <DetailPanel
      title={t("softwareTitle")}
      actions={
        <span className="inline-flex items-center gap-2">
          <Badge variant="secondary">
            {t("packageCount", { count: software.length })}
          </Badge>
          {software.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? t("collapse") : t("expand")}
            </Button>
          )}
        </span>
      }
    >
      {software.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noSoftware")}</p>
      ) : expanded ? (
        <div className="space-y-3">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
          />
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noMatches", { query })}
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto text-sm">
              {filtered.map((pkg, i) => (
                <li
                  key={`${pkg.name}-${i}`}
                  className="flex items-baseline justify-between gap-4 py-1.5 first:pt-0"
                >
                  <span className="truncate">{pkg.name}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {pkg.version ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </DetailPanel>
  );
}
