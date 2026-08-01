"use client";

import type { AgentContainer } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { DetailField, DetailPanel } from "@/components/detail-panel";
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

/**
 * The CONTAINER arm of the agent-facts projection (#1139) — the sibling of `getAgentInventory` /
 * `AgentInventoryPanel`, for the child nodes the reporting agent discovers on a host's container
 * runtime. A child's blob is `{ container, reportedAt }`: no `host` key, because a container is not
 * a host, so the host projection correctly declines it.
 *
 * It exists because "declines it" was not the end of the story. Both callers fall back to a RAW dump
 * when the host arm returns null — the Asset detail page renders every `specs` entry through
 * `formatSpecValue`, which `JSON.stringify`s an object — and confirming a container child mints an
 * Asset by default. So the first thing an operator saw on a confirmed container was its whole blob
 * as one line of JSON under **Custom fields**, a heading that means "a human typed this".
 */
export interface AgentContainerFacts {
  container: AgentContainer;
  reportedAt?: string;
  /** Human-added keys, so they still render — the same `extras` contract the host arm has. */
  extras: Array<[string, unknown]>;
}

/**
 * Keys these panels own or deliberately drop — everything else falls through to `extras`.
 *
 * Identical in spirit to the host arm's list: `_infraAutoCreated` is the API's provenance marker,
 * `diagnostics`/`agentSkew` are per-check-in machine bookkeeping that ride the NODE's blob.
 */
const CONTAINER_KEYS = new Set([
  "container",
  "reportedAt",
  "_infraAutoCreated",
  "diagnostics",
  "agentSkew",
]);

/**
 * The states this panel has a label for. `specs` is a raw `jsonb` column, so what comes back is
 * whatever was stored — the contract coerces every unrecognised runtime state to `unknown` on the way
 * IN, but a blob written by some other path would reach a missing-message error rather than a missing
 * row. A state we cannot name is simply not shown; the rest of the panel still renders.
 */
const RENDERABLE_STATES = new Set([
  "running",
  "created",
  "restarting",
  "paused",
  "exited",
  "removing",
  "dead",
  "unknown",
]);

/**
 * Project a container child's `specs` blob, or `null` when this is not one.
 *
 * The shape check mirrors the host arm exactly (a nested object carrying its own name field), which
 * is what keeps the two arms DISJOINT: a host blob has `host.hostname` and no `container`, a child
 * blob has `container.name` and no `host`. Neither caller has to choose between two matches.
 */
export function getAgentContainerFacts(
  specs: Record<string, unknown> | null | undefined,
): AgentContainerFacts | null {
  if (!specs) return null;
  const container = specs.container;
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return null;
  }
  const name = (container as Record<string, unknown>).name;
  if (typeof name !== "string" || name === "") return null;

  const reportedAt =
    typeof specs.reportedAt === "string" ? specs.reportedAt : undefined;
  const extras = Object.entries(specs).filter(
    ([key]) => !CONTAINER_KEYS.has(key),
  );

  return { container: container as AgentContainer, reportedAt, extras };
}

/**
 * A read-only render of the container facts the agent reported: what image is running, which build
 * (the digest is what actually pins that across a tag reuse), the runtime's state, and the published
 * ports. Every row is omitted when its field is missing — a partial report is valid (ADR-0074 §2).
 */
export function AgentContainerPanel({ facts }: { facts: AgentContainerFacts }) {
  const t = useTranslations("assets.detail.inventory");
  const tc = useTranslations("common");
  const tf = useTranslations("assets.detail");
  const { date } = useFormatters();
  const { container, reportedAt, extras } = facts;
  const ports = container.ports ?? [];

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
  rows.push({ label: t("containerName"), value: container.name, mono: true });
  if (container.image)
    rows.push({ label: t("image"), value: container.image, mono: true });
  if (container.imageDigest)
    rows.push({
      label: t("imageDigest"),
      value: container.imageDigest,
      mono: true,
    });
  if (container.state && RENDERABLE_STATES.has(container.state))
    rows.push({
      label: t("containerState"),
      value: t(`containerStates.${container.state}`),
    });
  if (container.id)
    rows.push({ label: t("containerId"), value: container.id, mono: true });

  return (
    <DetailPanel
      title={t("containerTitle")}
      actions={
        reportedAt ? (
          <span className="text-xs text-muted-foreground">
            {t("reportedAt", { date: date(reportedAt) })}
          </span>
        ) : undefined
      }
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {rows.map((row) => (
          <DetailField key={row.label} label={row.label} mono={row.mono}>
            {row.value}
          </DetailField>
        ))}
      </dl>

      {ports.length > 0 && (
        <div className="mt-6 space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t("portsTitle")}
          </h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("containerPort")}</TableHead>
                <TableHead>{t("hostPort")}</TableHead>
                <TableHead>{t("protocol")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ports.map((port, i) => (
                <TableRow key={`${port.containerPort}-${i}`}>
                  <TableCell className="font-mono tabular-nums">
                    {port.containerPort}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {port.hostPort != null
                      ? `${port.hostIp ? `${port.hostIp}:` : ""}${port.hostPort}`
                      : "—"}
                  </TableCell>
                  <TableCell className="font-mono">
                    {port.protocol ?? "—"}
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
  );
}
