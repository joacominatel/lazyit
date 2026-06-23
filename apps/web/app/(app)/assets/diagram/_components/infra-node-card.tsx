"use client";

import {
  CircleStackIcon,
  CpuChipIcon,
  CubeIcon,
  QuestionMarkCircleIcon,
  RectangleGroupIcon,
  ServerStackIcon,
  SignalIcon,
  Square3Stack3DIcon,
} from "@heroicons/react/24/outline";
import type { InfraNodeKind, InfraNodeStatus } from "@lazyit/shared";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { ComponentType } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { statusTone } from "@/lib/infra/canvas";
import { cn } from "@/lib/utils";

/**
 * The data React Flow carries on each infra node. `InfraNodeCard` reads it to render the kind icon,
 * label, status pill and IP. `statusLabel`/`kindLabel` are the next-intl-resolved display strings
 * (passed in by the canvas so this leaf component stays i18n-free and cheap to render).
 */
export interface InfraNodeData {
  label: string;
  kind: InfraNodeKind;
  status: InfraNodeStatus;
  ipAddress: string | null;
  statusLabel: string;
  kindLabel: string;
  /**
   * Blast-radius states (ADR-0070 §7, issue #755). All false unless impact mode is on for some node:
   * `impactOrigin` = the node whose blast radius is shown (the distinct source), `impactAffected` =
   * in the downstream set (highlighted), `impactDimmed` = outside the radius (faded back). The canvas
   * derives these from one impact query + the selected id.
   */
  impactOrigin?: boolean;
  impactAffected?: boolean;
  impactDimmed?: boolean;
  [key: string]: unknown;
}

/** One heroicon per generic node kind (ADR-0070 §2). A small, recognisable glyph, not a brand mark. */
const KIND_ICON: Record<InfraNodeKind, ComponentType<{ className?: string }>> = {
  PHYSICAL_HOST: ServerStackIcon,
  VM: Square3Stack3DIcon,
  CONTAINER: CubeIcon,
  CLUSTER: RectangleGroupIcon,
  NETWORK_DEVICE: SignalIcon,
  STORAGE: CircleStackIcon,
  APPLIANCE: CpuChipIcon,
  OTHER: QuestionMarkCircleIcon,
};

/**
 * Static, scanner-safe selected-ring class per status tone. The card wears a subtle left accent in
 * its status hue always; selection adds a full ring. Token-driven (no new palette) so it matches
 * every other status surface (ADR-0049).
 */
const SELECTED_RING: Record<ReturnType<typeof statusTone>, string> = {
  success: "ring-2 ring-success",
  danger: "ring-2 ring-destructive",
  neutral: "ring-2 ring-ring",
  warning: "ring-2 ring-warning",
  info: "ring-2 ring-info",
};

const ACCENT_BAR: Record<ReturnType<typeof statusTone>, string> = {
  success: "bg-success",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/40",
  warning: "bg-warning",
  info: "bg-info",
};

/**
 * The custom React Flow node for an infra topology node (ADR-0070 §6). A compact card: a kind icon
 * + label, a status badge, and the IP (when set). Connection `Handle`s on all four sides let edges
 * attach from any direction (the canvas auto-routes). Selection is a light ring — the rich drill-in
 * panel is issue #742, so click only selects here.
 */
export function InfraNodeCard({ data, selected }: NodeProps) {
  const node = data as InfraNodeData;
  const tone = statusTone(node.status);
  const Icon = KIND_ICON[node.kind] ?? QuestionMarkCircleIcon;

  return (
    <div
      className={cn(
        "relative flex min-w-44 max-w-60 items-start gap-2.5 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-card-foreground shadow-sm transition-[box-shadow,opacity,transform]",
        "hover:shadow-md",
        selected && SELECTED_RING[tone],
        // Blast radius (issue #755). The origin is the distinct source (brand ring + lift); affected
        // nodes wear a danger ring + faint tint so the radius pops; unaffected nodes fade back. These
        // win over the resting selected ring while impact mode is on (a more urgent cue).
        node.impactOrigin &&
          "ring-2 ring-primary ring-offset-2 ring-offset-background scale-[1.03] shadow-md",
        node.impactAffected && "ring-2 ring-destructive bg-destructive/5",
        node.impactDimmed && "opacity-35 saturate-50",
      )}
    >
      {/* status accent bar on the leading edge — a calm always-on colour cue, not colour-alone */}
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 w-1", ACCENT_BAR[tone])}
      />
      <span
        aria-hidden
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium leading-tight" title={node.label}>
          {node.label}
        </p>
        <p className="text-xs text-muted-foreground">{node.kindLabel}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={tone} dot>
            {node.statusLabel}
          </StatusBadge>
          {node.ipAddress ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {node.ipAddress}
            </span>
          ) : null}
        </div>
      </div>

      {/* Edge anchors on every side — small + low-contrast so they don't shout. The canvas is
          read/drag-only here; the create-edge flow is issue #742. */}
      <Handle type="target" position={Position.Top} className="!size-1.5 !bg-border" />
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !bg-border" />
      <Handle type="target" position={Position.Left} className="!size-1.5 !bg-border" />
      <Handle type="source" position={Position.Right} className="!size-1.5 !bg-border" />
    </div>
  );
}
