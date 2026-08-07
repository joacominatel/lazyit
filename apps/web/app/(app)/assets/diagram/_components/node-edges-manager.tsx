"use client";

import { ArrowPathIcon, PlusIcon } from "@heroicons/react/24/outline";
import {
  type InfraEdge,
  InfraEdgeKindSchema,
  MAX_PAGE_LIMIT,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Combobox } from "@/components/combobox";
import type { QuickViewData } from "@/components/quick-view-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCloseInfraEdge,
  useCreateInfraEdge,
  useInfraNodeEdgesHistory,
  useInfraNodes,
} from "@/lib/api/hooks/use-infra-nodes";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";

const EDGE_KIND_OPTIONS = InfraEdgeKindSchema.options;

/**
 * The edge create/manage surface inside the drill-in panel (ADR-0070 §3, issue #742). Lists the
 * node's ACTIVE connections (closable) and its closed HISTORY (read-only — a RUNS_ON migration shows
 * here), and offers an "add connection" dialog: pick a relationship kind + the other node (this node
 * is always the source). The server canonicalizes CONNECTS_TO, MIGRATES RUNS_ON, and may return a
 * friendly 409 (one-active-host / duplicate pair) — we surface that message verbatim via `notifyError`.
 *
 * `canManage` gates every write affordance; read-only viewers see the lists but no add/close buttons.
 */
export function NodeEdgesManager({
  nodeId,
  nodeLabel,
  canManage,
}: {
  nodeId: string;
  nodeLabel: string;
  canManage: boolean;
}) {
  const t = useTranslations("infra");
  const { date } = useFormatters();
  const [addOpen, setAddOpen] = useState(false);
  const { data: edges, isLoading, isError } = useInfraNodeEdgesHistory(nodeId);
  const closeEdge = useCloseInfraEdge();
  const [closingId, setClosingId] = useState<string | null>(null);

  // The ids this list actually has to NAME: the other endpoint of every edge (active or closed).
  // Sorted + de-duplicated so the query key is stable across re-renders.
  //
  // CAPPED at the page limit, because `?ids=` is capped there too (an over-cap batch is a 400, the
  // `GET /users?ids=` rule). One ADR-0095 hypervisor host really can carry 500 RUNS_ON edges, so this
  // is a live case, not a hypothetical. Past the cap a label falls back to the raw id — which reads as
  // a name that failed to resolve, not as a missing relationship — and that is deliberately the
  // failure we take: a 400 would blank the whole panel instead.
  const otherIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of edges ?? []) {
      ids.add(edge.sourceId === nodeId ? edge.targetId : edge.sourceId);
    }
    ids.delete(nodeId);
    return [...ids].sort().slice(0, MAX_PAGE_LIMIT);
  }, [edges, nodeId]);

  // Resolve exactly those (#1152, the `?ids=` batch-resolve precedent of ADR-0030 §6 / #961) instead
  // of fetching the whole node list and scanning it. Strictly better than what it replaced on a paged
  // endpoint: a scan of one window would print a raw cuid at the operator the moment an endpoint sat
  // outside it, and an edge is exactly the place where "which machine?" is the entire question. A
  // node this one has no edge to is not fetched at all.
  const { data: endpointPage } = useInfraNodes(
    { ids: otherIds, limit: MAX_PAGE_LIMIT },
    { enabled: otherIds.length > 0 },
  );

  /** The other endpoint's label for an edge (the node that ISN'T this one). */
  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of endpointPage?.items ?? []) map.set(node.id, node.label);
    return map;
  }, [endpointPage?.items]);

  const active = (edges ?? []).filter((e) => e.endedAt === null);
  const closed = (edges ?? []).filter((e) => e.endedAt !== null);

  function otherEndpoint(edge: InfraEdge): { id: string; label: string } {
    const otherId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
    return { id: otherId, label: labelById.get(otherId) ?? otherId };
  }

  async function handleClose(id: string) {
    setClosingId(id);
    try {
      await closeEdge.mutateAsync(id);
      toast.success(t("edges.closedToast"));
    } catch (error) {
      notifyError(error, t("edges.closeError"));
    } finally {
      setClosingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("edges.title")}
        </p>
        {canManage ? (
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            {t("edges.addAction")}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("panel.loading")}</p>
      ) : isError ? (
        <p className="text-sm text-muted-foreground">{t("edges.loadError")}</p>
      ) : (
        <>
          {/* Active connections — closable. */}
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("edges.noActive")}</p>
          ) : (
            <ul className="divide-y text-sm">
              {active.map((edge) => {
                const other = otherEndpoint(edge);
                const outbound = edge.sourceId === nodeId;
                return (
                  <li
                    key={edge.id}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate">
                        <span className="text-muted-foreground">
                          {t(`edgeKind.${edge.kind}`)}
                        </span>{" "}
                        <span aria-hidden className="text-muted-foreground">
                          {outbound ? "→" : "←"}
                        </span>{" "}
                        <span className="font-medium">{other.label}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("edges.since", { date: date(edge.startedAt) })}
                      </p>
                    </div>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleClose(edge.id)}
                        disabled={closingId === edge.id}
                      >
                        {closingId === edge.id && (
                          <ArrowPathIcon className="animate-spin" />
                        )}
                        {t("edges.closeAction")}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Closed history — read-only (migrations etc.). Only shown when there is any. */}
          {closed.length > 0 ? (
            <div className="space-y-1.5 pt-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("edges.closed")}
              </p>
              <ul className="divide-y text-sm text-muted-foreground">
                {closed.map((edge) => {
                  const other = otherEndpoint(edge);
                  const outbound = edge.sourceId === nodeId;
                  return (
                    <li key={edge.id} className="py-1.5 first:pt-0">
                      <p className="truncate">
                        {t(`edgeKind.${edge.kind}`)}{" "}
                        <span aria-hidden>{outbound ? "→" : "←"}</span>{" "}
                        <span className="text-foreground">{other.label}</span>
                      </p>
                      {edge.endedAt ? (
                        <p className="text-xs">
                          {t("edges.ended", { date: date(edge.endedAt) })}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      )}

      {/* Mounted only while open (the `MergeNodeDialog` mold), so every open starts from a clean
          picker — search box, chosen target and remembered label all fresh — without an effect
          writing state back into React on mount. */}
      {canManage && addOpen ? (
        <AddEdgeDialog
          open
          onOpenChange={setAddOpen}
          sourceId={nodeId}
          sourceLabel={nodeLabel}
        />
      ) : null}
    </div>
  );
}

type AddEdgeFormValues = { kind: string; targetId: string };

const ADD_EDGE_FORM_ID = "add-infra-edge-form";

/**
 * The "connect this node" dialog — pick a relationship kind + the other node (source = this node).
 *
 * The target picker is a SERVER-SEARCH {@link Combobox} (#1152): the typed query is debounced by the
 * picker and fed to a `q`-driven page of nodes, so any node in the estate is reachable by name. It
 * used to be handed the caller's whole node list, which on a paged endpoint would have made every
 * node past the first window simply unconnectable — the same ceiling ADR-0030 §8 (#199/#218) removed
 * from the KB asset picker, and the same fix.
 */
function AddEdgeDialog({
  open,
  onOpenChange,
  sourceId,
  sourceLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string;
  sourceLabel: string;
}) {
  const t = useTranslations("infra");
  const tc = useTranslations("common");
  const create = useCreateInfraEdge();
  const [query, setQuery] = useState("");
  // The chosen target's label, remembered at pick time: the picker's page changes as the operator
  // keeps typing, and the trigger must keep naming what they chose rather than falling back to a cuid.
  const [targetLabel, setTargetLabel] = useState<string>("");

  const form = useForm<AddEdgeFormValues>({
    mode: "onTouched",
    defaultValues: { kind: "", targetId: "" },
  });

  useEffect(() => {
    if (open) form.reset({ kind: "", targetId: "" });
  }, [open, form]);

  // Only fetched while the dialog is open — a closed picker should cost nothing.
  const { data: page, isFetching } = useInfraNodes(
    { q: query || undefined, limit: 50 },
    { enabled: open },
  );
  const nodes = useMemo(() => page?.items ?? [], [page?.items]);

  // Every node except this one is a valid target (a self-loop is rejected by the API and the schema).
  const targetItems = useMemo(
    () =>
      nodes
        .filter((node) => node.id !== sourceId)
        .map((node) => ({ value: node.id, label: node.label })),
    [nodes, sourceId],
  );

  // Quick View (epic #788): the page rows already in hand are a rich-enough preview source — no extra
  // fetch. So the target picker's eye previews kind/status/IP straight from the row before you connect it.
  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const targetQuickView = (value: string): QuickViewData | null => {
    const node = nodeById.get(value);
    return node
      ? {
          entity: "infra",
          data: {
            id: node.id,
            label: node.label,
            kind: node.kind,
            status: node.status,
            ipAddress: node.ipAddress,
            // `assetName` is deliberately left undefined: this preview stays the canvas basics, and
            // the linked asset is the drill-in's surface. (The row does carry it — unchanged by
            // #1135, which only dropped `specs` — so this is a choice, not a missing field.)
          },
        }
      : null;
  };

  const onSubmit = form.handleSubmit((values) => {
    if (!values.kind || !values.targetId) return;
    create.mutate(
      {
        sourceId,
        targetId: values.targetId,
        kind: values.kind as (typeof EDGE_KIND_OPTIONS)[number],
      },
      {
        onSuccess: () => {
          toast.success(t("edges.createdToast"));
          onOpenChange(false);
        },
        // Surfaces the API's friendly RUNS_ON one-active-host / duplicate-pair 409 verbatim (§3).
        onError: (error) => notifyError(error, t("edges.error")),
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("edges.addTitle")}</DialogTitle>
          <DialogDescription>{t("edges.addDescription")}</DialogDescription>
        </DialogHeader>

        <form
          id={ADD_EDGE_FORM_ID}
          onSubmit={(e) => {
            e.stopPropagation();
            onSubmit(e);
          }}
          noValidate
        >
          <div className="space-y-4">
            <Controller
              control={form.control}
              name="kind"
              rules={{ required: true }}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="edge-kind" required>
                    {t("edges.kindLabel")}
                  </FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="edge-kind" className="w-full">
                      <SelectValue placeholder={t("edges.kindPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {EDGE_KIND_OPTIONS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`edgeKind.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="targetId"
              rules={{ required: true }}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="edge-target" required>
                    {t("edges.targetLabel")}
                  </FieldLabel>
                  <Combobox
                    id="edge-target"
                    value={field.value}
                    onValueChange={(value) => {
                      setTargetLabel(
                        targetItems.find((item) => item.value === value)?.label ??
                          "",
                      );
                      field.onChange(value);
                    }}
                    items={targetItems}
                    onSearchChange={setQuery}
                    loading={isFetching}
                    selectedLabel={targetLabel || undefined}
                    placeholder={t("edges.targetPlaceholder")}
                    searchPlaceholder={t("edges.targetSearch")}
                    emptyText={t("edges.targetEmpty")}
                    loadingText={tc("searching")}
                    quickView={targetQuickView}
                  />
                  <FieldDescription>
                    {t("edges.directionNote")}{" "}
                    <span className="font-medium text-foreground">
                      {sourceLabel}
                    </span>
                  </FieldDescription>
                </Field>
              )}
            />
          </div>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            type="submit"
            form={ADD_EDGE_FORM_ID}
            disabled={create.isPending}
          >
            {create.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("edges.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
