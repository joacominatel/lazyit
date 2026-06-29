"use client";

import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  NodeToolbar,
  type OnNodeDrag,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ExclamationTriangleIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import type { InfraEdge, InfraEdgeKind, InfraNode } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Callout } from "@/components/callout";
import { ErrorState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  useInfraEdges,
  useInfraNodes,
  useUpdateInfraNodePosition,
} from "@/lib/api/hooks/use-infra-nodes";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  debounce,
  edgeStyle,
  gridPosition,
  layoutNodes,
  placementOffset,
  statusTone,
} from "@/lib/infra/canvas";
import { cn } from "@/lib/utils";
import { InfraEdge as InfraEdgeRenderer, type InfraEdgeData } from "./infra-edge";
import { InfraEmptyState } from "./infra-empty-state";
import { InfraNodeCard, type InfraNodeData } from "./infra-node-card";

/** Position write debounce (ms) — long enough to collapse a drag burst, short enough to feel live. */
const PERSIST_DEBOUNCE_MS = 500;
/** Deep-link / focus camera glide (ms) — the one cinematic exception to the ≤220ms budget (brief). */
const FOCUS_DURATION_MS = 400;
/** Tidy reflow glide + its fit-view (ms) — the workhorse UI duration (ADR-0049 motion budget). */
const TIDY_DURATION_MS = 220;
/** How long the one-shot focus pulse plays before it auto-clears (matches the CSS keyframe). */
const FOCUS_PULSE_MS = 600;

const nodeTypes = { infra: InfraNodeCard };
const edgeTypes = { infra: InfraEdgeRenderer };

/** True when the OS asks for reduced motion — every custom animation no-ops to instant when so. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** The imperative handle the canvas surfaces to its host (diagram-view) — currently just focusNode. */
export interface InfraCanvasApi {
  /** Centre + zoom onto a node and play a one-shot focus pulse (issue #765). No-op if id is unknown. */
  focusNode: (nodeId: string) => void;
}

/**
 * The infra topology board (ADR-0070 §6, issue #741). Renders nodes from `GET /infra/nodes` and the
 * graph's edges (fanned out per-node), styled by status/kind. Nodes are draggable; a settled drag
 * trailing-debounces a `PATCH /infra/nodes/:id/position`. Pan/zoom + fit-view on load come from
 * React Flow. Hover shows quick facts AND spotlights the node's neighbourhood; click selects a node
 * and bubbles up via `onSelectNode` — the SEAM for #742's drill-in panel.
 *
 * Edges are a *system* (issue #767): a custom edge type encodes each kind by colour + line-style +
 * marker + (DEPENDS_ON only) animated flow, with an on-edge kind label on hover/selection. A "Tidy"
 * button runs a dagre layered layout (#766); fresh creates land at the viewport centre, fanned so
 * they don't stack (#761); and a `focusNode(id)` primitive (#765) drives the deep-link/“view in
 * topology” landing. `ReactFlowProvider` wraps the board so the canvas hooks can read the instance.
 */
export function InfraCanvas({
  onSelectNode,
  impactRootId = null,
  affectedIds,
  onApiReady,
}: {
  /** Called with the selected node id (or null when cleared). The seam for #742's drill-in panel. */
  onSelectNode?: (nodeId: string | null) => void;
  /**
   * The blast-radius root (ADR-0070 §7, issue #755) — the selected node when impact mode is ON, else
   * null. When set, this node renders as the origin and `affectedIds` highlight; everything else dims.
   */
  impactRootId?: string | null;
  /** The downstream affected set (ids). Empty/undefined when impact mode is off or nothing depends. */
  affectedIds?: Set<string>;
  /** Receives the canvas's imperative API once mounted (issue #765 — diagram-view's `?focus=1`). */
  onApiReady?: (api: InfraCanvasApi) => void;
}) {
  const t = useTranslations("infra");
  const { data: rawNodes, isLoading, isError, error, refetch } = useInfraNodes();
  const nodeIds = useMemo(() => (rawNodes ?? []).map((n) => n.id), [rawNodes]);
  const {
    edges: rawEdges,
    isError: edgesError,
    refetch: refetchEdges,
  } = useInfraEdges(nodeIds);

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
      <CanvasBoard
        nodes={nodes}
        edges={rawEdges}
        edgesError={edgesError}
        onRetryEdges={refetchEdges}
        onSelectNode={onSelectNode}
        impactRootId={impactRootId}
        affectedIds={affectedIds}
        onApiReady={onApiReady}
      />
    </ReactFlowProvider>
  );
}

/** The mounted board — data is loaded and non-empty by the time we reach here. */
function CanvasBoard({
  nodes: infraNodes,
  edges: infraEdges,
  edgesError,
  onRetryEdges,
  onSelectNode,
  impactRootId,
  affectedIds,
  onApiReady,
}: {
  nodes: InfraNode[];
  edges: InfraEdge[];
  /** At least one per-node edge fetch failed — some relationships are missing from the graph (#778). */
  edgesError: boolean;
  /** Re-run the per-node edge fetches; on success the inline notice auto-clears. */
  onRetryEdges: () => void;
  onSelectNode?: (nodeId: string | null) => void;
  impactRootId: string | null;
  affectedIds?: Set<string>;
  onApiReady?: (api: InfraCanvasApi) => void;
}) {
  const t = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const persist = useUpdateInfraNodePosition();
  const { fitView, screenToFlowPosition } = useReactFlow();
  // Pin React Flow's color mode to the resolved app theme (next-themes class), NOT the OS — so
  // RF's own `.dark` toggles in lockstep with our `.dark` class and the themed `--xy-*` chrome
  // vars (globals.css) resolve to the matching light/dark tokens. `system` would follow the OS and
  // diverge from an explicit in-app theme choice (issue #763).
  const { resolvedTheme } = useTheme();
  const colorMode = resolvedTheme === "dark" ? "dark" : "light";

  // Resolve i18n labels once per kind/status so the (i18n-free) node card just renders strings.
  const kindLabel = (kind: InfraNode["kind"]) => t(`kind.${kind}`);
  const statusLabel = (status: InfraNode["status"]) => t(`status.${status}`);
  const edgeKindLabel = (kind: InfraEdgeKind) => t(`edgeKind.${kind}`);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<InfraNodeData>>(
    [],
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge<InfraEdgeData>>(
    [],
  );
  // The hovered node id drives BOTH the quick-facts toolbar and the hover spotlight (issue #767).
  const [hovered, setHovered] = useState<string | null>(null);
  // The selected edge id — its kind label shows even without hover (issue #767, on-edge label).
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // The node currently playing a one-shot focus pulse (issue #765); cleared by a timeout.
  const [focusPulseId, setFocusPulseId] = useState<string | null>(null);

  // Impact mode is on when a root is set AND its radius has resolved (ADR-0070 §7, issue #755). The
  // blast radius is derived state: each node carries three flags so the (i18n-free) card just toggles
  // classes — the root is the origin, members of `affectedIds` highlight, and everything else dims.
  // Off ⇒ all flags false. ponytail (#775): gate on `affectedIds !== undefined`, not just the root —
  // `impactRootId` flips on the instant the toggle does, but `affectedIds` stays undefined until the
  // query resolves (an *empty* set still counts as resolved). Dimming on the root alone flashes the
  // whole map to the reassuring "nothing depends on this" state before the real radius lights up.
  const inImpactMode = impactRootId !== null && affectedIds !== undefined;

  // The hover spotlight neighbourhood (issue #767): the hovered node + every node one hop away on
  // any active edge. Deferred to impact mode (its dim is the more urgent cue) and to no-hover. The
  // dim set is "every node NOT in the neighbourhood"; an empty/absent neighbourhood dims nothing.
  const spotlightNeighbourhood = useMemo(() => {
    if (inImpactMode || hovered === null) return null;
    const set = new Set<string>([hovered]);
    for (const edge of infraEdges) {
      if (edge.sourceId === hovered) set.add(edge.targetId);
      if (edge.targetId === hovered) set.add(edge.sourceId);
    }
    return set;
  }, [inImpactMode, hovered, infraEdges]);

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
        const isOrigin = inImpactMode && node.id === impactRootId;
        const isAffected = inImpactMode && Boolean(affectedIds?.has(node.id));
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
            impactOrigin: isOrigin,
            impactAffected: isAffected,
            // Dim only when impact mode is on and this node is neither origin nor affected.
            impactDimmed: inImpactMode && !isOrigin && !isAffected,
            // Spotlight dim: hovered-neighbourhood mode is on and this node is outside it.
            spotlightDimmed:
              spotlightNeighbourhood !== null &&
              !spotlightNeighbourhood.has(node.id),
            focusPulse: node.id === focusPulseId,
          },
        };
      });
    });
    // kindLabel/statusLabel are stable per render of `t`; the data/flag inputs are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    infraNodes,
    setRfNodes,
    inImpactMode,
    impactRootId,
    affectedIds,
    spotlightNeighbourhood,
    focusPulseId,
  ]);

  // Sync edges from the query, styled by kind via the per-kind `edgeStyle` descriptor (issue #767).
  // In impact mode an edge stays full-strength only when both endpoints are inside the blast radius;
  // the hover spotlight dims any edge with neither endpoint in the hovered neighbourhood. The kind
  // label shows on hover (either endpoint) or selection only — the resting map stays uncluttered.
  useEffect(() => {
    const inRadius = (id: string) =>
      id === impactRootId || Boolean(affectedIds?.has(id));
    const inSpotlight = (id: string) =>
      spotlightNeighbourhood === null || spotlightNeighbourhood.has(id);
    // Parallel-edge fan-out (issue #773): group edges by their UNORDERED node pair so the floating
    // edge can offset each one along the line's normal — two edges between the same nodes (either
    // direction, any kind) don't draw on top of each other. `pairKey` sorts the two ids so A→B and
    // B→A share a group; `slot`/`size` give each edge its index within the group.
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const pairCount = new Map<string, number>();
    for (const edge of infraEdges) {
      const key = pairKey(edge.sourceId, edge.targetId);
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
    const pairSlot = new Map<string, number>();
    setRfEdges(
      infraEdges.map((edge) => {
        const style = edgeStyle(edge.kind);
        const key = pairKey(edge.sourceId, edge.targetId);
        const slot = pairSlot.get(key) ?? 0;
        pairSlot.set(key, slot + 1);
        const impactDimmed =
          inImpactMode && !(inRadius(edge.sourceId) && inRadius(edge.targetId));
        // An edge is in the spotlight when EITHER endpoint is the hovered node or its neighbour.
        const spotlightDimmed =
          spotlightNeighbourhood !== null &&
          !(inSpotlight(edge.sourceId) && inSpotlight(edge.targetId));
        const showLabel =
          hovered === edge.sourceId ||
          hovered === edge.targetId ||
          selectedEdgeId === edge.id;
        return {
          id: edge.id,
          source: edge.sourceId,
          target: edge.targetId,
          type: "infra",
          // Selecting the edge surfaces its label and keeps RF's click affordance.
          selected: selectedEdgeId === edge.id,
          style: {
            stroke: style.stroke,
            strokeWidth: style.width,
            strokeDasharray: style.dashArray,
          },
          markerEnd: style.marker
            ? { type: style.marker, color: style.stroke }
            : undefined,
          data: {
            kind: edge.kind,
            kindLabel: edgeKindLabel(edge.kind),
            dimmed: impactDimmed || spotlightDimmed,
            showLabel,
            parallelIndex: slot,
            parallelCount: pairCount.get(key) ?? 1,
          },
        };
      }),
    );
    // edgeKindLabel is stable per render of `t`; the graph + highlight inputs are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    infraEdges,
    setRfEdges,
    inImpactMode,
    impactRootId,
    affectedIds,
    spotlightNeighbourhood,
    hovered,
    selectedEdgeId,
  ]);

  // One trailing-debounced persister, holding the latest position per node id. ponytail: a single
  // debounced map-flush, not a debounce-per-node, so a flurry of drags collapses to one write each.
  // The pending map, the mutate fn and the debounced flush all live in refs so render never reads
  // them; the flush is built once on mount and pulls the live mutate fn through `persistRef` (so it
  // stays current without re-creating the debounce). All ref reads happen inside effects/handlers.
  const pendingRef = useRef(new Map<string, { x: number; y: number }>());
  const persistRef = useRef(persist.mutate);
  const flushRef = useRef<(() => void) | null>(null);
  // The board wrapper — used to read the viewport centre for fresh-create placement (#761).
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  // ── focusNode primitive (issue #765) ───────────────────────────────────────────────────────────
  // Centre + zoom onto a node, then play a one-shot pulse that auto-clears. Reused by the deep-link
  // (`?node=&focus=1`), a fresh create (#761), and the future "View in topology" button. Reduced
  // motion runs the camera instantly (duration 0) and skips the pulse — only the camera move stays.
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const focusNode = useCallback(
    (nodeId: string) => {
      const reduced = prefersReducedMotion();
      fitView({
        nodes: [{ id: nodeId }],
        duration: reduced ? 0 : FOCUS_DURATION_MS,
        maxZoom: 1.2,
      });
      if (reduced) return;
      setFocusPulseId(nodeId);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(
        () => setFocusPulseId(null),
        FOCUS_PULSE_MS,
      );
    },
    [fitView],
  );

  useEffect(() => () => clearTimeout(pulseTimerRef.current), []);

  // Surface the API to the host (diagram-view) once, so `?focus=1` can drive a focus on mount.
  useEffect(() => {
    onApiReady?.({ focusNode });
  }, [onApiReady, focusNode]);

  // ── Fresh-create placement (issue #761) ─────────────────────────────────────────────────────────
  // New nodes are created with no x/y and would pile up at the same default spot. The moment a node
  // we haven't seen appears WITHOUT a saved position, drop it at the current viewport centre with a
  // per-create spiral offset (so consecutive creates fan out), persist it, and focus it so it
  // arrives on screen. `seenIds` tracks which node ids have already been placed/seen; `createSeq`
  // spirals each consecutive un-positioned create. Manager-only (viewer creates 403 server-side, but
  // viewers can't open the create dialog anyway). Dragged positions are never clobbered: we only act
  // on nodes with a null saved position that are new to us.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const createSeqRef = useRef(0);
  useEffect(() => {
    // Seed the seen-set on first run so existing nodes aren't treated as fresh creates.
    if (seenIdsRef.current.size === 0 && infraNodes.length > 0) {
      for (const node of infraNodes) seenIdsRef.current.add(node.id);
      return;
    }
    const fresh = infraNodes.filter(
      (node) =>
        !seenIdsRef.current.has(node.id) && (node.x == null || node.y == null),
    );
    for (const node of infraNodes) seenIdsRef.current.add(node.id);
    if (!canManage || fresh.length === 0) return;

    // The flow-space centre of the current viewport — where the eye is — as the placement anchor.
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });

    let lastId = "";
    for (const node of fresh) {
      const pos = placementOffset(center, createSeqRef.current);
      createSeqRef.current += 1;
      setRfNodes((prev) =>
        prev.map((n) => (n.id === node.id ? { ...n, position: pos } : n)),
      );
      persistRef.current({ id: node.id, x: pos.x, y: pos.y });
      lastId = node.id;
    }
    // Land the last fresh node on screen (a single create is the common case). Defer one frame so RF
    // has committed the new position before the camera flies to it (otherwise it'd target the stale
    // grid slot the node-sync effect assigned this same commit).
    if (lastId) {
      const target = lastId;
      requestAnimationFrame(() => focusNode(target));
    }
    // setRfNodes/screenToFlowPosition are stable; the trigger is the node list changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infraNodes, canManage]);

  // ── Tidy / auto-arrange (issue #766) ────────────────────────────────────────────────────────────
  // Run the pure dagre layered layout, glide every node to its new slot (a 220ms transform
  // transition, instant under reduced motion), fit the view, and persist each moved position via the
  // per-node mutation (no bulk endpoint — looping is the accepted ponytail; the estate is small).
  const [tidying, setTidying] = useState(false);
  const tidyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(tidyTimerRef.current), []);

  const onTidy = useCallback(() => {
    if (!canManage) return;
    const laid = layoutNodes(
      infraNodes.map((n) => ({ id: n.id })),
      infraEdges.map((e) => ({
        sourceId: e.sourceId,
        targetId: e.targetId,
        kind: e.kind,
      })),
    );
    const posById = new Map(laid.map((n) => [n.id, n]));
    const reduced = prefersReducedMotion();

    const applyLayout = () => {
      setRfNodes((prev) =>
        prev.map((n) => {
          const next = posById.get(n.id);
          return next ? { ...n, position: { x: next.x, y: next.y } } : n;
        }),
      );
      fitView({ duration: reduced ? 0 : TIDY_DURATION_MS, padding: 0.2, maxZoom: 1.2 });
    };

    if (reduced) {
      // No glide: jump straight to the tidy layout.
      applyLayout();
    } else {
      // Turn the reflow glide ON first (the transform transition on every RF node, via the `tidying`
      // wrapper class) so the transition is live BEFORE the positions change a frame later — without
      // the frame gap the browser captures no "from" state and the nodes jump. Glide off after it
      // settles so dragging stays snappy.
      setTidying(true);
      requestAnimationFrame(applyLayout);
      tidyTimerRef.current = setTimeout(() => setTidying(false), TIDY_DURATION_MS + 50);
    }

    // Persist every moved position (per-node loop — no bulk endpoint; the estate is small, ponytail).
    for (const next of laid) persistRef.current({ id: next.id, x: next.x, y: next.y });
  }, [canManage, infraNodes, infraEdges, fitView, setRfNodes]);

  const hoveredNode = hovered
    ? infraNodes.find((n) => n.id === hovered)
    : undefined;

  return (
    <div
      ref={wrapperRef}
      className="size-full overflow-hidden rounded-lg border border-border bg-muted/20"
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeMouseEnter={(_e, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onNodeClick={(_e, node) => {
          setSelectedEdgeId(null);
          onSelectNode?.(node.id);
        }}
        onEdgeClick={(_e, edge) => setSelectedEdgeId(edge.id)}
        onPaneClick={() => {
          setSelectedEdgeId(null);
          onSelectNode?.(null);
        }}
        nodesConnectable={false}
        // Floating edges (issue #773) anchor to whichever node side faces the neighbour, so an edge
        // may attach to a handle of either polarity. Loose mode lets a connection touch any handle
        // regardless of type — the RF "floating edges" pattern (handles stay purely visual anchors;
        // the path is computed from node geometry in the custom edge).
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode={colorMode}
        // The Tidy reflow glide (issue #766): while `tidying`, every RF node animates its position
        // transform over the workhorse 220ms ease. Applied only during the reflow window so dragging
        // stays instant; the global reduced-motion guard (globals.css) collapses it to ~0 regardless.
        className={cn(
          tidying &&
            "[&_.react-flow__node]:transition-transform [&_.react-flow__node]:duration-[var(--dur-slow)] [&_.react-flow__node]:ease-[var(--ease-out-quad)]",
        )}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--border)"
        />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          className="!hidden md:!block"
          maskColor="color-mix(in oklab, var(--background) 60%, transparent)"
          nodeColor="var(--muted-foreground)"
        />

        {/* Tidy / auto-arrange (issue #766) — manager-only; viewers can't persist a layout. */}
        {canManage ? (
          <Panel position="top-right">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTidy}
              className="shadow-sm"
            >
              <Squares2X2Icon />
              {t("tidy.action")}
            </Button>
          </Panel>
        ) : null}

        {/* Partial edge-fetch notice (issue #778) — a per-node edge fetch failed, so some relationships
            are missing from the graph. A subtle, non-blocking banner (NOT a toast — this state persists
            while edges are absent) over the still-valid nodes, with a Retry that re-runs the fetches;
            it auto-clears the moment a retry succeeds. */}
        {edgesError ? (
          <Panel position="top-center">
            <Callout
              tone="warning"
              icon={<ExclamationTriangleIcon />}
              className="items-center py-2 shadow-md backdrop-blur-sm"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm">{t("edges.partialError")}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onRetryEdges()}
                >
                  {t("edges.retry")}
                </Button>
              </div>
            </Callout>
          </Panel>
        ) : null}

        {/* Edge legend (issue #767 delight) — a collapsible key to the relationship kinds. */}
        <Panel position="bottom-left">
          <EdgeLegend />
        </Panel>

        {/* Hover quick-facts (ADR-0070 §6). NodeToolbar auto-positions above the hovered node; a
            lightweight card, no extra dep. The rich drill-in (owner/KB/secrets) is the panel. */}
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

/** The 5 relationship kinds, in the host→guest→dependency→backup→adjacency reading order. */
const LEGEND_KINDS: InfraEdgeKind[] = [
  "RUNS_ON",
  "MEMBER_OF",
  "DEPENDS_ON",
  "BACKS_UP_TO",
  "CONNECTS_TO",
];

/**
 * The edge legend (issue #767 delight) — a collapsible key mapping each kind to its colour + line
 * style so a reader decodes the map without guessing. ~markup over tokens: each row draws a tiny SVG
 * line with the kind's real stroke + dash so the legend swatch matches the canvas exactly. Collapsed
 * by default to stay out of the way; the toggle is keyboard-reachable.
 */
function EdgeLegend() {
  const t = useTranslations("infra");
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card/95 text-card-foreground shadow-sm backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium"
      >
        {open ? (
          // Content (the <ul>) renders BELOW this toggle, so the chevron follows the standard
          // disclosure direction: expanded points up (collapse), collapsed points down (#775).
          <ChevronUpIcon className="size-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
        )}
        {t("legend.title")}
      </button>
      {open ? (
        <ul className="space-y-1.5 px-2.5 pb-2.5 pt-0.5">
          {LEGEND_KINDS.map((kind) => {
            const style = edgeStyle(kind);
            return (
              <li key={kind} className="flex items-center gap-2 text-xs">
                <svg
                  width="28"
                  height="8"
                  viewBox="0 0 28 8"
                  className="shrink-0"
                  aria-hidden
                >
                  <line
                    x1="1"
                    y1="4"
                    x2="27"
                    y2="4"
                    stroke={style.stroke}
                    strokeWidth={style.width}
                    strokeDasharray={style.dashArray}
                    strokeLinecap="round"
                  />
                </svg>
                <span className="text-muted-foreground">{t(`edgeKind.${kind}`)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
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
