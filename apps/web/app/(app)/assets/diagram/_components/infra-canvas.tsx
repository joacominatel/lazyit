"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  NodeToolbar,
  type OnNodeDrag,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { InfraEdge, InfraNode } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorState } from "@/components/resource-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  useInfraEdges,
  useInfraNodes,
  useUpdateInfraNodePosition,
} from "@/lib/api/hooks/use-infra-nodes";
import { useCan } from "@/lib/hooks/use-permissions";
import { debounce, edgeStroke, gridPosition, statusTone } from "@/lib/infra/canvas";
import { InfraEmptyState } from "./infra-empty-state";
import { InfraNodeCard, type InfraNodeData } from "./infra-node-card";

/** Position write debounce (ms) — long enough to collapse a drag burst, short enough to feel live. */
const PERSIST_DEBOUNCE_MS = 500;

const nodeTypes = { infra: InfraNodeCard };

/**
 * The infra topology board (ADR-0070 §6, issue #741). Renders nodes from `GET /infra/nodes` and the
 * graph's edges (fanned out per-node), styled by status/kind. Nodes are draggable; a settled drag
 * trailing-debounces a `PATCH /infra/nodes/:id/position`. Pan/zoom + fit-view on load come from
 * React Flow. Hover shows quick facts; click selects a node and bubbles up via `onSelectNode` — the
 * SEAM for #742's rich drill-in panel (NOT built here).
 *
 * `ReactFlowProvider` wraps the board so child hooks (and #742's panel) can read the instance.
 */
export function InfraCanvas({
  onSelectNode,
}: {
  /** Called with the selected node id (or null when cleared). The seam for #742's drill-in panel. */
  onSelectNode?: (nodeId: string | null) => void;
}) {
  const t = useTranslations("infra");
  const { data: rawNodes, isLoading, isError, error, refetch } = useInfraNodes();
  const nodeIds = useMemo(() => (rawNodes ?? []).map((n) => n.id), [rawNodes]);
  const { edges: rawEdges } = useInfraEdges(nodeIds);

  if (isLoading) return <CanvasSkeleton label={t("loading")} />;
  if (isError) {
    return (
      <div className="rounded-lg border border-border p-6">
        <ErrorState
          title={t("error.title")}
          description={t("error.description")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const nodes = rawNodes ?? [];
  if (nodes.length === 0) return <InfraEmptyState />;

  return (
    <ReactFlowProvider>
      <CanvasBoard nodes={nodes} edges={rawEdges} onSelectNode={onSelectNode} />
    </ReactFlowProvider>
  );
}

/** The mounted board — data is loaded and non-empty by the time we reach here. */
function CanvasBoard({
  nodes: infraNodes,
  edges: infraEdges,
  onSelectNode,
}: {
  nodes: InfraNode[];
  edges: InfraEdge[];
  onSelectNode?: (nodeId: string | null) => void;
}) {
  const t = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const persist = useUpdateInfraNodePosition();

  // Resolve i18n labels once per kind/status so the (i18n-free) node card just renders strings.
  const kindLabel = (kind: InfraNode["kind"]) => t(`kind.${kind}`);
  const statusLabel = (status: InfraNode["status"]) => t(`status.${status}`);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<InfraNodeData>>(
    [],
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [hovered, setHovered] = useState<string | null>(null);

  // Sync the React Flow node list from the query. ponytail: a node already on the board keeps its
  // live (possibly mid-drag) position; only data fields refresh — so a background refetch never
  // yanks a node the operator is dragging. Un-positioned nodes get a deterministic grid slot.
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return infraNodes.map((node, index) => {
        const existing = prevById.get(node.id);
        const position =
          existing?.position ??
          (node.x != null && node.y != null
            ? { x: node.x, y: node.y }
            : gridPosition(index));
        return {
          id: node.id,
          type: "infra",
          position,
          data: {
            label: node.label,
            kind: node.kind,
            status: node.status,
            ipAddress: node.ipAddress,
            kindLabel: kindLabel(node.kind),
            statusLabel: statusLabel(node.status),
          },
        };
      });
    });
    // kindLabel/statusLabel are stable per render of `t`; depending on infraNodes is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infraNodes, setRfNodes]);

  // Sync edges from the query, styled by kind.
  useEffect(() => {
    setRfEdges(
      infraEdges.map((edge) => ({
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        type: "smoothstep",
        style: { stroke: edgeStroke(edge.kind), strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeStroke(edge.kind) },
        data: { kind: edge.kind },
      })),
    );
  }, [infraEdges, setRfEdges]);

  // One trailing-debounced persister, holding the latest position per node id. ponytail: a single
  // debounced map-flush, not a debounce-per-node, so a flurry of drags collapses to one write each.
  // The pending map, the mutate fn and the debounced flush all live in refs so render never reads
  // them; the flush is built once on mount and pulls the live mutate fn through `persistRef` (so it
  // stays current without re-creating the debounce). All ref reads happen inside effects/handlers.
  const pendingRef = useRef(new Map<string, { x: number; y: number }>());
  const persistRef = useRef(persist.mutate);
  const flushRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    persistRef.current = persist.mutate;
  }, [persist.mutate]);

  useEffect(() => {
    const pending = pendingRef.current;
    flushRef.current = debounce(() => {
      const batch = new Map(pending);
      pending.clear();
      for (const [id, pos] of batch) persistRef.current({ id, ...pos });
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  const onNodeDragStop: OnNodeDrag<Node<InfraNodeData>> = (_event, node) => {
    if (!canManage) return; // viewers can pan/zoom but their drags don't persist (API would 403)
    pendingRef.current.set(node.id, { x: node.position.x, y: node.position.y });
    flushRef.current?.();
  };

  const hoveredNode = hovered
    ? infraNodes.find((n) => n.id === hovered)
    : undefined;

  return (
    <div className="size-full overflow-hidden rounded-lg border border-border bg-muted/20">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeMouseEnter={(_e, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onNodeClick={(_e, node) => onSelectNode?.(node.id)}
        onPaneClick={() => onSelectNode?.(null)}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!hidden md:!block" />

        {/* Hover quick-facts (ADR-0070 §6). NodeToolbar auto-positions above the hovered node; a
            lightweight card, no extra dep. The rich drill-in (owner/KB/secrets) is issue #742. */}
        {hoveredNode ? (
          <NodeToolbar
            nodeId={hoveredNode.id}
            isVisible
            position={Position.Top}
            className="pointer-events-none"
          >
            <div className="min-w-48 space-y-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md">
              <p className="truncate text-sm font-medium" title={hoveredNode.label}>
                {hoveredNode.label}
              </p>
              <dl className="space-y-1 text-xs">
                <Fact label={t("facts.kind")} value={kindLabel(hoveredNode.kind)} />
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t("facts.status")}</dt>
                  <dd>
                    <StatusBadge tone={statusTone(hoveredNode.status)} dot>
                      {statusLabel(hoveredNode.status)}
                    </StatusBadge>
                  </dd>
                </div>
                <Fact
                  label={t("facts.ip")}
                  value={hoveredNode.ipAddress ?? t("facts.noIp")}
                  mono={Boolean(hoveredNode.ipAddress)}
                />
              </dl>
            </div>
          </NodeToolbar>
        ) : null}
      </ReactFlow>
    </div>
  );
}

/** A label/value row in the hover quick-facts card. */
function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono" : undefined}>{value}</dd>
    </div>
  );
}

/** Loading skeleton that mirrors the board's frame (a few ghost node cards on the gridded surface). */
function CanvasSkeleton({ label }: { label: string }) {
  return (
    <div
      className="relative size-full overflow-hidden rounded-lg border border-border bg-muted/20"
      role="status"
      aria-label={label}
    >
      <div className="grid grid-cols-2 gap-6 p-8 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
