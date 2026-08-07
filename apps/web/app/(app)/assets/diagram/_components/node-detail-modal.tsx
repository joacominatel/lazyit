"use client";

import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
  CheckIcon,
  CubeIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  LinkIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type {
  InfraAssetCandidate,
  InfraNodeChild,
  InfraNodeDetail,
  InfraNodeKind,
  InfraNodeOwner,
  InfraNodeStatus,
  InfraSecretRef,
  InfraShortcut,
} from "@lazyit/shared";
import {
  InfraNodeKindSchema,
  InfraNodeStatusSchema,
  InfraShortcutSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import { SecretChip } from "@/components/markdown-secret-chip-view";
import { Combobox, type ComboboxItem } from "@/components/combobox";
import { ErrorState } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInvalidateAssets } from "@/lib/api/hooks/use-assets";
import {
  useAttachInfraSecret,
  useDeleteInfraNode,
  useDetachInfraSecret,
  useInfraNodeDetail,
  useUpdateInfraNode,
} from "@/lib/api/hooks/use-infra-nodes";
import { useHandleSuggestions } from "@/lib/secret-manager/hooks/use-chip";
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { statusTone } from "@/lib/infra/canvas";
import { displayChassis } from "@/lib/infra/chassis";
import {
  AgentContainerPanel,
  getAgentContainerFacts,
} from "../../[id]/_components/agent-container-facts";
import {
  AgentInventoryPanel,
  AgentSoftwarePanel,
  getAgentInventory,
} from "../../[id]/_components/agent-inventory-panel";
import {
  AgentBadge,
  AgentFreshness,
  AgentOutdatedBadge,
  AgentPolicyBadge,
} from "./agent-provenance";
import { DeleteNodeDialog } from "./delete-node-dialog";
import { NodeAssetControl } from "./node-asset-control";
import {
  relinkAssetArchived,
  relinkNextStep,
  type RelinkProgress,
} from "./relink-sequence";
import { NodeChangesTab } from "./node-changes-tab";
import { NodeEdgesManager } from "./node-edges-manager";
import { nodeSectionKey } from "./node-detail-keys";
import { planNodeDetailTabs, type NodeDetailTabId } from "./node-detail-tabs";

const STATUS_OPTIONS = InfraNodeStatusSchema.options;
const KIND_OPTIONS = InfraNodeKindSchema.options;

/**
 * The node drill-in (ADR-0070 §6, issue #742) — since #1182 a LARGE TABBED MODAL rather than the
 * right-hand rail it started as.
 *
 * The rail was designed for a hand-drawn node with a label and a kind. Contract v2 then filled it:
 * identity and provenance badges, the editable fields, the blast-radius action, the whole reported
 * facts block (a container's published-ports table was already cut off horizontally in normal use),
 * the installed-software list, and a Changes tab. The problem was never only width — everything on
 * that rail carried the same weight, so an operator read all of it to find one thing.
 *
 * So: tabs, and only tabs that answer a question someone arrives with. **General** is what this node
 * is and who is responsible for it; **Reported facts** is what the machine says it is made of;
 * **Software** is what is installed on it; **Connections** is what it is wired to and what runs on
 * it; **Changes** is what moved. The set ADAPTS per node — see {@link planNodeDetailTabs}, which
 * derives it from the `specs` projections rather than from `source`, so a container never opens onto
 * the host renderer and an agent node with no reported block gets no empty facts tab.
 *
 * **Blast radius moved OUT** and onto the canvas (#1182). Its entire output is drawn on the graph —
 * it highlights the dependent nodes — so an action whose answer is already on screen has no business
 * behind a modal the operator then has to close in order to read it.
 *
 * `label` is the title (the canvas display name always wins); `assetName` is the secondary inventory
 * name. Write controls (rename, kind/IP/status, the asset link, edges, secrets, shortcuts,
 * remove-from-map) are gated on `infra:manage` — read-only viewers see the same facts without the
 * affordances, so the API never 403s on a render. `infra:manage` is what `PATCH /infra/nodes/:id`
 * itself requires, so the gate here mirrors the gate there rather than inventing a stricter one.
 */
export function NodeDetailModal({
  nodeId,
  onClose,
  onSelectNode,
}: {
  /** The node whose detail is open, or null when the modal is closed. */
  nodeId: string | null;
  /** Called to close the modal. Selection on the canvas is the caller's business, not ours. */
  onClose: () => void;
  /** Open another node's detail in place (used by the duplicate-IP peers to jump across — #847). */
  onSelectNode: (nodeId: string) => void;
}) {
  const t = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const {
    data: node,
    isLoading,
    isError,
    error,
    refetch,
  } = useInfraNodeDetail(nodeId);

  return (
    <Dialog open={nodeId !== null} onOpenChange={(open) => !open && onClose()}>
      {/* The base DialogContent scrolls its whole body; this one must not. The header and the tab bar
          stay put while only the active tab's panel scrolls, so the node you are reading never loses
          its name off the top. Hence the explicit grid rows + `overflow-hidden`, and `p-0` because
          each region owns its own padding. */}
      <DialogContent className="grid h-[min(46rem,calc(100svh-3rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-3xl lg:max-w-5xl">
        {isLoading ? (
          // Radix requires a DialogTitle in EVERY content branch for screen readers (issue #762).
          // The skeleton has no visible title, so we give it an sr-only one.
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{t("panel.loading")}</DialogTitle>
              <DialogDescription>{t("panel.loading")}</DialogDescription>
            </DialogHeader>
            <ModalSkeleton label={t("panel.loading")} />
          </>
        ) : isError || !node ? (
          // A failed detail fetch is recoverable — mirror the canvas's ErrorState (with onRetry) a
          // few files over (issue #776), reusing the shared retry affordance. The DialogTitle stays
          // sr-only so Radix gets its required title for screen readers (the #762 a11y fix).
          <div className="row-span-2 flex h-full flex-col p-6">
            <DialogHeader className="sr-only">
              <DialogTitle>{t("panel.loadError")}</DialogTitle>
              <DialogDescription>{t("panel.loadError")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-1 items-center justify-center">
              <ErrorState
                title={t("panel.loadError")}
                description={t("error.description")}
                onRetry={() => refetch()}
                error={error}
              />
            </div>
          </div>
        ) : (
          <ModalBody
            node={node}
            canManage={canManage}
            onClose={onClose}
            onSelectNode={onSelectNode}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The loaded modal. Split out so hooks here only run once a node has resolved. */
function ModalBody({
  node,
  canManage,
  onClose,
  onSelectNode,
}: {
  node: InfraNodeDetail;
  canManage: boolean;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const t = useTranslations("infra");
  const tone = statusTone(node.status);
  const updateNode = useUpdateInfraNode();

  const plan = useMemo(
    () => planNodeDetailTabs({ source: node.source, specs: node.specs }),
    [node.source, node.specs],
  );

  // The open tab. Held here (not left to the primitive's own state) for two reasons: the Changes
  // tab's query is gated on it (see `NodeChangesTab`), and the tab set differs per node — jumping
  // from a host to a container (the duplicate-IP peers do exactly that) must not leave the modal
  // pointing at a `software` tab that node does not have. `active` falls back to General for that.
  const [tab, setTab] = useState<NodeDetailTabId>("general");
  const active: NodeDetailTabId = plan.tabs.includes(tab) ? tab : "general";

  return (
    <>
      <DialogHeader className="gap-2 border-b px-5 pt-5 pb-3 text-left">
        {canManage ? (
          <EditableTitle
            key={`${node.id}:${node.label}`}
            label={node.label}
            pending={updateNode.isPending}
            onSave={(label) =>
              updateNode.mutateAsync({ id: node.id, patch: { label } })
            }
          />
        ) : (
          <DialogTitle className="pr-10 text-base">{node.label}</DialogTitle>
        )}
        <DialogDescription className="sr-only">
          {t(`kind.${node.kind}`)}
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{t(`kind.${node.kind}`)}</Badge>
          <StatusBadge tone={tone} dot>
            {t(`status.${node.status}`)}
          </StatusBadge>
          {/* Provenance (ADR-0074 §3): mark machine-reported nodes so an operator knows the inventory
              is auto-maintained — and how fresh the last report is (muted/"stale" when OFFLINE). */}
          {node.source === "AGENT" ? <AgentBadge /> : null}
          {node.source === "AGENT" ? (
            <AgentOutdatedBadge agentVersion={node.agentVersion} />
          ) : null}
          {/* Whether this host has actually PICKED UP the current fleet policy (#1140). It renders
              nothing for a node that has never echoed one — a manual node, or an agent older than
              the policy channel — because those will never echo one, and "pending" would imply a
              wait that resolves. */}
          {node.source === "AGENT" ? (
            <AgentPolicyBadge policyRevision={node.policyRevision} />
          ) : null}
          {node.source === "AGENT" ? (
            <AgentFreshness
              reportingSource={node.reportingSource}
              lastReportedAt={node.lastReportedAt}
              status={node.status}
            />
          ) : null}
        </div>
        {node.assetName ? (
          <p className="text-xs text-muted-foreground">
            {t("panel.inventoryName")}:{" "}
            {/* Back-link to the inventory record (issue #765) — mirrors the owner→/users/<id> link
                below, closing the asset↔node round-trip. The asset is the link only when the node is
                still asset-backed (assetId present); a detached node shows the name as plain text. */}
            {node.assetId ? (
              <Link
                href={`/assets/${node.assetId}`}
                className="font-medium text-foreground hover:underline"
              >
                {node.assetName}
              </Link>
            ) : (
              <span className="font-medium text-foreground">
                {node.assetName}
              </span>
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("panel.noInventoryName")}
          </p>
        )}
      </DialogHeader>

      <Tabs
        value={active}
        onValueChange={(next) => setTab(next as NodeDetailTabId)}
        className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0"
      >
        {/* The tab bar scrolls sideways rather than wrapping: five triggers in Spanish are wider than
            three in English, and a wrapped second row would push the content down by a line this
            fixed-height layout has not reserved. */}
        <TabsList className="px-5">
          {plan.tabs.map((id) => (
            <TabsTrigger
              key={id}
              value={id}
              indicatorClassName="data-[state=active]:border-pillar-inventory"
            >
              {t(`panel.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent
          value="general"
          className="min-h-0 space-y-6 overflow-y-auto p-5"
        >
          <GeneralTab
            node={node}
            canManage={canManage}
            onSelectNode={onSelectNode}
            onRemoved={onClose}
          />
        </TabsContent>

        {plan.factsArm ? (
          <TabsContent value="facts" className="min-h-0 overflow-y-auto p-5">
            <ReportedFactsTab specs={node.specs} arm={plan.factsArm} />
          </TabsContent>
        ) : null}

        {plan.tabs.includes("software") ? (
          <TabsContent value="software" className="min-h-0 overflow-y-auto p-5">
            <SoftwareTab specs={node.specs} />
          </TabsContent>
        ) : null}

        <TabsContent
          value="connections"
          className="min-h-0 space-y-6 overflow-y-auto p-5"
        >
          <ChildrenSection nodes={node.children} />
          <Separator />
          <NodeEdgesManager
            nodeId={node.id}
            nodeLabel={node.label}
            canManage={canManage}
          />
        </TabsContent>

        <TabsContent value="changes" className="min-h-0 overflow-y-auto p-5">
          <NodeChangesTab nodeId={node.id} active={active === "changes"} />
        </TabsContent>
      </Tabs>
    </>
  );
}

/**
 * **General** — what this node is, and who is responsible for it.
 *
 * The editable configuration sits at the top left, where an operator expects it (issue #764); the
 * asset-backed payoff the drill-in exists for (owners, KB, secret handles, shortcuts) fills the rest.
 * Two columns from `lg` up: the modal is wide enough that a single column would leave half the
 * surface empty and still make the reader scroll. Removing the node from the map closes the whole
 * modal — there is nothing left to read — and lifecycle belongs with identity and nowhere else.
 */
function GeneralTab({
  node,
  canManage,
  onSelectNode,
  onRemoved,
}: {
  node: InfraNodeDetail;
  canManage: boolean;
  onSelectNode: (nodeId: string) => void;
  onRemoved: () => void;
}) {
  const t = useTranslations("infra");
  const { date } = useFormatters();
  const deleteNode = useDeleteInfraNode();
  const chassis = displayChassis(node.chassis);

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-5">
          {canManage ? (
            <DetailsSection node={node} />
          ) : (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  {t("panel.ipLabel")}
                </dt>
                <dd
                  className={
                    node.ipAddress ? "font-mono" : "text-muted-foreground"
                  }
                >
                  {node.ipAddress ?? t("facts.noIp")}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  {t("panel.createdLabel")}
                </dt>
                <dd>{date(node.createdAt)}</dd>
              </div>
              {/* The reported form factor, for the reader too (ADR-0093 §6) — it is the fact that
                  explains why a machine is or is not drawn on the map, so hiding it from viewers
                  would leave exactly the people who cannot change anything unable to understand
                  what they are looking at. */}
              {chassis ? (
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">
                    {t("panel.chassisLabel")}
                  </dt>
                  <dd>{t(`chassis.${chassis}`)}</dd>
                </div>
              ) : null}
            </dl>
          )}

          {/* Soft duplicate-IP warning (ADR-0090, #847) — a NON-BLOCKING heads-up when other live
            nodes carry this node's exact IP. Display-only: the IP is still valid + saved (no DB
            uniqueness); this just names the peers so an operator can reconcile. Shown to every reader
            (a fact), and kept directly under the IP field it is about. */}
          {(node.ipConflict?.length ?? 0) > 0 ? (
            <IpConflictNotice
              peers={node.ipConflict ?? []}
              onSelectNode={onSelectNode}
            />
          ) : null}

          {/* Duplicate-inventory suspicion (ADR-0093 §8.5) — for installs that already minted a
              second, serial-less Asset for a machine that was in inventory all along, back when a
              serial collision was answered by dropping the serial. Display-only, like the IP notice
              above it: it NAMES the other row and stops there. There is deliberately no merge action
              and no one-click anything in v1, because machine-merging two inventory rows — their
              assignments, history, tags and attachments — is not something an upgrade does while
              nobody is looking. `?? null` for the read tolerance an older API needs. */}
          {node.duplicateAssetSuspicion ? (
            <DuplicateAssetNotice
              nodeId={node.id}
              asset={node.duplicateAssetSuspicion}
              canManage={canManage}
            />
          ) : null}

          {/* The inventory LINK itself (#1202) — attach when the node carries none, detach when it
              does, with the confirmation naming which of the two detach outcomes is about to run.
              Gated on `infra:manage`, which is exactly how `PATCH /infra/nodes/:id` gates itself, so
              a reader never sees a button that would 403 on them. It sits right under the identity
              block because the link IS identity: it is what makes the node asset-backed. */}
          {canManage ? (
            <Section title={t("panel.assetLink.title")}>
              <NodeAssetControl
                nodeId={node.id}
                assetId={node.assetId}
                assetName={node.assetName}
                assetAutoCreated={node.assetAutoCreated}
              />
            </Section>
          ) : null}

          {/* Status toggle (write — gated). */}
          {canManage ? <StatusSection node={node} /> : null}
        </div>

        <div className="space-y-5">
          <OwnersSection owners={node.owners} />
          <ArticlesSection articles={node.articleLinks} />
        </div>
      </div>

      <Separator />

      <div className="grid gap-6 lg:grid-cols-2">
        {canManage ? (
          <SecretsEditor
            key={nodeSectionKey("secrets", node.id, node.secretRefs)}
            nodeId={node.id}
            secretRefs={node.secretRefs}
          />
        ) : (
          <SecretsSection secretRefs={node.secretRefs} />
        )}
        {canManage ? (
          <ShortcutsEditor
            key={nodeSectionKey("shortcuts", node.id, node.shortcuts)}
            nodeId={node.id}
            shortcuts={node.shortcuts}
          />
        ) : (
          <ShortcutsSection shortcuts={node.shortcuts} />
        )}
      </div>

      {/* Lifecycle: remove from map (soft-delete, restorable). */}
      {canManage ? (
        <>
          <Separator />
          <RemoveControl
            label={node.label}
            onConfirm={() => deleteNode.mutateAsync(node.id)}
            onRemoved={onRemoved}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * **Reported facts** — the agent's own account of the machine, read-only.
 *
 * Reuses the Assets detail projections ({@link getAgentInventory} + {@link AgentInventoryPanel} for a
 * host, {@link getAgentContainerFacts} + {@link AgentContainerPanel} for a CONTAINER child, #1139) so
 * there is ONE renderer per shape across the app — no duplicated cpu/ram/os/disks/serial layout, and
 * no second place to keep the container layout in step with.
 *
 * `arm` comes from {@link planNodeDetailTabs}, which resolved it from these same two projections, so
 * this tab exists only when one of them matched. It re-runs the projection rather than taking the
 * parsed object as a prop, which keeps the "declines the other kind's blob" contract in one place: if
 * the arm and the blob ever disagreed this renders nothing, instead of falling through to a raw JSON
 * dump — the defect #1139 fixed, and the one easiest to reintroduce while moving components.
 */
function ReportedFactsTab({
  specs,
  arm,
}: {
  specs: Record<string, unknown> | null;
  arm: "host" | "container";
}) {
  const inventory = arm === "host" ? getAgentInventory(specs) : null;
  const container = arm === "container" ? getAgentContainerFacts(specs) : null;
  if (inventory) {
    return <AgentInventoryPanel inventory={inventory} showSoftware={false} />;
  }
  if (container) return <AgentContainerPanel facts={container} />;
  return null;
}

/**
 * **Software** — the installed-package list. It is the largest single block a host reports and the
 * biggest reason the old rail scrolled as far as it did, so it gets its own room. Expanded on
 * arrival: an operator who clicked a tab named "Software" has already asked the question the
 * collapse was there to defer.
 */
function SoftwareTab({ specs }: { specs: Record<string, unknown> | null }) {
  const inventory = getAgentInventory(specs);
  if (!inventory?.software) return null;
  return <AgentSoftwarePanel software={inventory.software} defaultExpanded />;
}

/** A titled section with the app's small uppercase label. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </section>
  );
}

/**
 * Click-to-rename modal title (issue #764, manager-only). Reads as the plain `DialogTitle` until
 * clicked, then becomes an inline `Input` that commits on blur/Enter and cancels on Esc — the same
 * lightweight, non-animated inline-edit pattern used for the IP field below. Empty input cancels
 * (a node always needs a name; the shared schema also rejects an empty label server-side).
 */
function EditableTitle({
  label,
  pending,
  onSave,
}: {
  label: string;
  pending: boolean;
  onSave: (label: string) => Promise<unknown>;
}) {
  const t = useTranslations("infra");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  // The draft resets on a node/label change because the parent keys this component on `${id}:${label}`
  // — a remount, not an effect (avoids the cascading-render the set-state-in-effect lint flags).
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    const next = value.trim();
    if (!next || next === label) {
      setValue(label);
      setEditing(false);
      return;
    }
    onSave(next)
      .then(() => toast.success(t("panel.editedToast")))
      .catch((error) => {
        notifyError(error, t("panel.editError"));
        setValue(label);
      });
    setEditing(false);
  }

  if (!editing) {
    return (
      <DialogTitle asChild className="pr-10 text-base">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="group flex items-center gap-1.5 text-left transition-colors duration-150 ease-[var(--ease-out-quad)] hover:text-foreground/80 motion-reduce:transition-none"
          title={t("panel.labelEditHint")}
        >
          <span className="truncate">{label}</span>
          <PencilSquareIcon
            className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 ease-[var(--ease-out-quad)] group-hover:opacity-100 motion-reduce:transition-none"
            aria-hidden
          />
        </button>
      </DialogTitle>
    );
  }

  return (
    <Input
      ref={inputRef}
      aria-label={t("panel.labelLabel")}
      value={value}
      disabled={pending}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setValue(label);
          setEditing(false);
        }
      }}
      className="h-8 max-w-md text-base font-semibold"
    />
  );
}

/**
 * The editable Details block (issue #764, manager-only): kind (a `Select`) + IP (an inline input).
 * Each field patches the node on its own via `useUpdateInfraNode` — optimistic through the shared
 * query invalidation, so the canvas card re-renders live. The added-on date stays read-only (it isn't
 * editable).
 */
function DetailsSection({ node }: { node: InfraNodeDetail }) {
  const t = useTranslations("infra");
  const { date } = useFormatters();
  const updateNode = useUpdateInfraNode();
  const chassis = displayChassis(node.chassis);

  function handleKindChange(next: string) {
    updateNode.mutate(
      { id: node.id, patch: { kind: next as InfraNodeKind } },
      {
        onSuccess: () => toast.success(t("panel.editedToast")),
        onError: (error) => notifyError(error, t("panel.editError")),
      },
    );
  }

  return (
    <Section title={t("panel.detailsTitle")}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label
            htmlFor="node-kind-edit"
            className="text-xs text-muted-foreground"
          >
            {t("panel.kindLabel")}
          </label>
          <Select value={node.kind} onValueChange={handleKindChange}>
            <SelectTrigger
              id="node-kind-edit"
              className="w-full"
              disabled={updateNode.isPending}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <InlineIpField
          key={`${node.id}:${node.ipAddress ?? ""}`}
          nodeId={node.id}
          ipAddress={node.ipAddress}
        />

        {/* The reported form factor (ADR-0093 §2/§6) — READ-ONLY on purpose, and sitting among the
            editable fields precisely so the difference is visible. Chassis is a fact the agent owns
            and rewrites on every report; there is no `chassisSource` and no manual counterpart,
            because a human never writes it and so there is no human write to protect. It is also
            the fact that decides whether this node is drawn on the map by default, which is the one
            question an operator will arrive at this panel asking. */}
        {chassis ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {t("panel.chassisLabel")}
            </p>
            <p className="text-sm">{t(`chassis.${chassis}`)}</p>
          </div>
        ) : null}

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t("panel.createdLabel")}
          </p>
          <p className="text-sm">{date(node.createdAt)}</p>
        </div>
      </div>
    </Section>
  );
}

/** The live-state select (write — the caller gates it on `infra:manage`). */
function StatusSection({ node }: { node: InfraNodeDetail }) {
  const t = useTranslations("infra");
  const updateNode = useUpdateInfraNode();

  function handleStatusChange(next: string) {
    updateNode.mutate(
      { id: node.id, patch: { status: next as InfraNodeStatus } },
      {
        onSuccess: () => toast.success(t("panel.statusUpdatedToast")),
        onError: (error) => notifyError(error, t("panel.statusError")),
      },
    );
  }

  return (
    <Section title={t("panel.statusTitle")}>
      <Select value={node.status} onValueChange={handleStatusChange}>
        <SelectTrigger className="w-full" disabled={updateNode.isPending}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((status) => (
            <SelectItem key={status} value={status}>
              {t(`status.${status}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t("panel.statusDescription")}
      </p>
    </Section>
  );
}

/**
 * Inline IP field (issue #764): plain text until edited, commits on blur/Enter, cancels on Esc.
 * An empty value clears the IP (`ipAddress: null`, which the shared schema allows). Mirrors the
 * rename pattern — minimal, non-animated, one patch per save.
 *
 * Manual override (issue #1081): saving an IP here marks the node's `ipAddressSource=MANUAL` so the
 * next agent report never clobbers the human value. That stamp is derived SERVER-SIDE from the
 * presence of `ipAddress` in the patch (never a client-settable field), so this component only sends
 * `{ ipAddress }` — no extra payload — and the provenance marker stays trustworthy.
 */
function InlineIpField({
  nodeId,
  ipAddress,
}: {
  nodeId: string;
  ipAddress: string | null;
}) {
  const t = useTranslations("infra");
  const updateNode = useUpdateInfraNode();
  // Draft resets on node/IP change via the parent's `key` (a remount), not an effect.
  const [value, setValue] = useState(ipAddress ?? "");

  function commit() {
    const next = value.trim();
    const current = ipAddress ?? "";
    if (next === current) return;
    updateNode.mutate(
      { id: nodeId, patch: { ipAddress: next === "" ? null : next } },
      {
        onSuccess: () => toast.success(t("panel.editedToast")),
        onError: (error) => {
          notifyError(error, t("panel.editError"));
          setValue(current);
        },
      },
    );
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor="node-ip-edit" className="text-xs text-muted-foreground">
        {t("panel.ipEditLabel")}
      </label>
      <Input
        id="node-ip-edit"
        value={value}
        disabled={updateNode.isPending}
        placeholder={t("panel.ipPlaceholder")}
        className="font-mono"
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setValue(ipAddress ?? "");
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/**
 * Non-blocking duplicate-IP notice (ADR-0090, issue #847). Renders only when the backend's `ipConflict`
 * read field reports other LIVE nodes carrying this node's exact `ipAddress`. A soft signal, never a
 * block — the IP is a valid, saved value (there is no DB uniqueness) — so it wears the `warning` tone
 * (not `destructive`) and reuses the modal's own list idiom: each peer is a button that opens that
 * node's detail in place (`onSelectNode`) so an operator can jump over and reconcile, with kind +
 * status in a tooltip. The caller gates on the count, so `peers` here is always non-empty.
 */
function IpConflictNotice({
  peers,
  onSelectNode,
}: {
  peers: InfraNodeChild[];
  onSelectNode: (nodeId: string) => void;
}) {
  const t = useTranslations("infra");
  return (
    <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-start gap-2 text-sm font-medium text-warning-text">
        <ExclamationTriangleIcon
          className="mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <span>{t("panel.ipConflictWarning", { count: peers.length })}</span>
      </div>
      <ul className="space-y-1.5 text-sm">
        {peers.map((peer) => (
          <li key={peer.id}>
            <button
              type="button"
              onClick={() => onSelectNode(peer.id)}
              className="flex w-full items-center gap-2 rounded-sm text-left transition-colors duration-150 ease-[var(--ease-out-quad)] hover:text-foreground/80 motion-reduce:transition-none"
              title={`${t(`kind.${peer.kind}`)} · ${t(`status.${peer.status}`)}`}
            >
              <CubeIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate font-medium">{peer.label}</span>
              <span className="text-xs text-muted-foreground">
                {t(`kind.${peer.kind}`)}
              </span>
              <StatusBadge
                tone={statusTone(peer.status)}
                dot
                className="ml-auto"
              >
                {t(`status.${peer.status}`)}
              </StatusBadge>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Duplicate-inventory suspicion (ADR-0093 §8.5) — *"this machine looks like it is already in your
 * inventory, twice"*.
 *
 * The server recognises the shape the old collision retry left behind: this node's linked Asset was
 * auto-created and carries **no** serial, while the serial the machine reports belongs to a different
 * live Asset. That other Asset is what this names.
 *
 * **Still never a merge.** ADR-0093 §8.5 forbids machine-merging two inventory rows — two sets of
 * assignments, history, tags and attachments — and there is no asset-merge endpoint in the repo by
 * design. What this notice DOES now offer (#1202) is the thing §7 explicitly authorises: the existing
 * deliberate two-step, `PATCH { assetId: null }` then `PATCH { assetId: <curated> }`, sequenced behind
 * one button while the API keeps its #1117 re-point 400 intact. Nothing is merged; the node is simply
 * pointed at the row the operator kept, and the auto-created stand-in is archived by the ordinary §5
 * detach because it carries the marker. The judgement is still theirs — the link above is a READ, and
 * it is there to be used before the button is.
 *
 * Until #1202 this notice deliberately routed nowhere, because the drill-in carried no attach/detach
 * control and pointing at one would have been a promise the UI could not keep. That control now
 * exists, so the notice ends somewhere.
 *
 * `warning` tone rather than `destructive`: nothing is broken, and both rows are intact. It is a
 * tidy-up waiting for someone with the context to do it right.
 */
function DuplicateAssetNotice({
  nodeId,
  asset,
  canManage,
}: {
  nodeId: string;
  asset: InfraAssetCandidate;
  canManage: boolean;
}) {
  const t = useTranslations("infra");
  return (
    <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-start gap-2 text-sm font-medium text-warning-text">
        <ExclamationTriangleIcon
          className="mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <span>{t("panel.duplicateAssetWarning")}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("panel.duplicateAssetHint")}
      </p>
      <div className="space-y-1 text-sm">
        <Link
          href={`/assets/${asset.id}`}
          className="flex items-center gap-2 font-medium hover:underline"
        >
          <CubeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{asset.name}</span>
          <ArrowTopRightOnSquareIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </Link>
        {asset.serial ? (
          <p className="text-xs text-muted-foreground">
            {t("panel.duplicateAssetSerial")}{" "}
            <span className="font-mono">{asset.serial}</span>
          </p>
        ) : null}
      </div>
      {/* Gated exactly like every other write here: `infra:manage`, which is what the PATCH requires. */}
      {canManage ? <RelinkToCuratedControl nodeId={nodeId} peer={asset} /> : null}
    </div>
  );
}

/**
 * The ADR-0093 §7 remediation, sequenced (issue #1202): detach the auto-created stand-in, then link
 * the curated row this notice named.
 *
 * **Why one button rather than two manual steps.** The moment step 1 lands, the node carries no
 * `assetId` — and `resolveDuplicateAssetSuspicion` returns null for such a node, so this entire notice
 * disappears on the next read, taking the only on-screen pointer to `peer` with it. An operator who
 * stopped between the two steps would be left with an archived asset, an unlinked node, and nothing
 * naming what they were reconciling to. So `peer.id` is captured in this component's closure BEFORE
 * step 1 runs, and a step-2 failure keeps the dialog standing with an explicit resume — see
 * {@link relinkNextStep}, which is why the progress is a value and not just control flow.
 *
 * The two PATCHes are the operator's own existing calls, not a new endpoint and not a merge.
 */
function RelinkToCuratedControl({
  nodeId,
  peer,
}: {
  nodeId: string;
  peer: InfraAssetCandidate;
}) {
  const t = useTranslations("infra");
  const tc = useTranslations("common");
  const updateNode = useUpdateInfraNode();
  const invalidateAssets = useInvalidateAssets();
  const [open, setOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<RelinkProgress>("not-started");

  const archived = relinkAssetArchived(progress);

  async function run() {
    setIsPending(true);
    // Local mirror of the progress: `setProgress` is async, and step 2 must not read a stale value.
    let reached = progress;
    try {
      if (relinkNextStep(reached) === "detach") {
        await updateNode.mutateAsync({ id: nodeId, patch: { assetId: null } });
        reached = "detached";
        setProgress(reached);
        // The stand-in was soft-deleted (it carries the marker), so the assets caches are stale.
        invalidateAssets();
      }
      if (relinkNextStep(reached) === "link") {
        await updateNode.mutateAsync({ id: nodeId, patch: { assetId: peer.id } });
        reached = "linked";
        setProgress(reached);
      }
      toast.success(t("panel.duplicateAssetRelinkedToast", { name: peer.name }));
      setOpen(false);
    } catch (error) {
      // Deliberately NOT a bare toast when step 1 already landed: the dialog stays open, states that
      // the stand-in is archived, and the button becomes a resume that never replays the detach.
      notifyError(error, t("panel.duplicateAssetRelinkError"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <LinkIcon />
        {t("panel.duplicateAssetRelinkAction")}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // Never reset `progress` on close: reopening after a half-completed sequence must resume,
          // and re-running the detach against the relinked node would archive the CURATED row.
          if (!isPending) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("panel.duplicateAssetRelinkTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("panel.duplicateAssetRelinkBody", { name: peer.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {archived ? (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
              {t("panel.duplicateAssetRelinkResume", { name: peer.name })}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>
              {tc("cancel")}
            </AlertDialogCancel>
            <Button onClick={() => void run()} disabled={isPending}>
              {isPending && <ArrowPathIcon className="animate-spin" />}
              {archived
                ? t("panel.duplicateAssetRelinkResumeSubmit", { name: peer.name })
                : t("panel.duplicateAssetRelinkSubmit")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Editable shortcuts list (issue #764, manager-only). Each row is a `{ label, url }` pair of inputs
 * plus a remove button; an "Add shortcut" row appends a blank pair. The WHOLE array is saved in one
 * `shortcuts: [...]` patch (the API replaces it wholesale), validated client-side against the shared
 * `InfraShortcutSchema` so a bad URL is caught before the round-trip (the server validates too). A
 * draft is committed on the explicit Save button — local edits never auto-fire a patch per keystroke.
 */
function ShortcutsEditor({
  nodeId,
  shortcuts,
}: {
  nodeId: string;
  shortcuts: InfraShortcut[] | null;
}) {
  const t = useTranslations("infra");
  const updateNode = useUpdateInfraNode();
  // Draft resets on a node / saved-shortcuts change via the parent's `key` (a remount), not an effect.
  const [rows, setRows] = useState<InfraShortcut[]>(shortcuts ?? []);
  const [error, setError] = useState<string | null>(null);

  // The draft differs from what's persisted — only then is there anything to save.
  const dirty = JSON.stringify(rows) !== JSON.stringify(shortcuts ?? []);

  function update(index: number, patch: Partial<InfraShortcut>) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setError(null);
  }

  function save() {
    // Validate the whole array against the shared schema (same rules the API enforces) before patching.
    const parsed = InfraShortcutSchema.array().safeParse(
      rows.map((row) => ({ label: row.label.trim(), url: row.url.trim() })),
    );
    if (!parsed.success) {
      setError(t("panel.shortcutInvalid"));
      return;
    }
    updateNode.mutate(
      { id: nodeId, patch: { shortcuts: parsed.data } },
      {
        onSuccess: () => {
          toast.success(t("panel.shortcutsSavedToast"));
          setError(null);
        },
        onError: (err) => notifyError(err, t("panel.editError")),
      },
    );
  }

  return (
    <Section title={t("panel.shortcutsTitle")}>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="flex-1 space-y-1.5">
              <Input
                aria-label={t("panel.shortcutLabelPlaceholder")}
                value={row.label}
                placeholder={t("panel.shortcutLabelPlaceholder")}
                disabled={updateNode.isPending}
                onChange={(event) =>
                  update(index, { label: event.target.value })
                }
              />
              <Input
                aria-label={t("panel.shortcutUrlPlaceholder")}
                value={row.url}
                placeholder={t("panel.shortcutUrlPlaceholder")}
                disabled={updateNode.isPending}
                onChange={(event) => update(index, { url: event.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive"
              aria-label={t("panel.shortcutRemove")}
              disabled={updateNode.isPending}
              onClick={() => {
                setRows((prev) => prev.filter((_, i) => i !== index));
                setError(null);
              }}
            >
              <TrashIcon />
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={updateNode.isPending}
          onClick={() => {
            setRows((prev) => [...prev, { label: "", url: "" }]);
            setError(null);
          }}
        >
          <PlusIcon />
          {t("panel.shortcutAdd")}
        </Button>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {dirty ? (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={updateNode.isPending}
              onClick={() => {
                setRows(shortcuts ?? []);
                setError(null);
              }}
            >
              <XMarkIcon />
              {t("panel.editCancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={updateNode.isPending}
              onClick={save}
            >
              <CheckIcon />
              {t("panel.editSave")}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** Active owners via the linked Asset's assignments (asset-centric — ADR-0004/0019). */
function OwnersSection({ owners }: { owners: InfraNodeOwner[] }) {
  const t = useTranslations("infra");
  return (
    <Section title={t("panel.ownersTitle")}>
      {owners.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.noOwners")}</p>
      ) : (
        <ul className="space-y-2">
          {owners.map((owner) => {
            const gone = owner.deletedAt !== null;
            const name = `${owner.firstName} ${owner.lastName}`.trim();
            return (
              <li key={owner.assignmentId} className="flex items-center gap-3">
                <UserAvatar
                  firstName={owner.firstName}
                  lastName={owner.lastName}
                  email={owner.email}
                  size="sm"
                  className={gone ? "opacity-50 grayscale" : undefined}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/users/${owner.userId}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {name || owner.email}
                    </Link>
                    {gone ? (
                      <Badge
                        variant="outline"
                        className="text-muted-foreground"
                      >
                        {t("panel.ownerLeft")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {owner.email}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** PUBLISHED KB articles linked to the node's Asset, each linking to `/kb/:slug`. */
function ArticlesSection({
  articles,
}: {
  articles: InfraNodeDetail["articleLinks"];
}) {
  const t = useTranslations("infra");
  return (
    <Section title={t("panel.articlesTitle")}>
      {articles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.noArticles")}</p>
      ) : (
        <ul className="divide-y text-sm">
          {articles.map((article) => (
            <li
              key={article.id}
              className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <BookOpenIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <Link
                  href={`/kb/${article.slug}`}
                  className="truncate font-medium hover:underline"
                >
                  {article.title}
                </Link>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/kb/${article.slug}`}>
                  {t("panel.viewArticle")}
                  <ArrowTopRightOnSquareIcon />
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * Secret references — HANDLES ONLY, never values (INV-10, ADR-0061). We render each `handle` as a
 * label + a {@link SecretChip}: the same by-handle reveal used by KB prose, so a vault member can
 * unlock the value in place (client-side decrypt) while non-members see a locked chip. The server
 * never sees plaintext; this surface only ever holds the handle + label metadata.
 */
function SecretsSection({ secretRefs }: { secretRefs: InfraSecretRef[] }) {
  const t = useTranslations("infra");
  return (
    <Section title={t("panel.secretsTitle")}>
      {secretRefs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.noSecrets")}</p>
      ) : (
        <ul className="space-y-2">
          {secretRefs.map((ref) => (
            <li key={`${ref.vaultId}:${ref.handle}`} className="space-y-1">
              <div className="flex items-center gap-2">
                <KeyIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate text-sm font-medium">
                  {ref.label}
                </span>
              </div>
              {/* Reveal is client-side only (INV-10): SecretChip resolves the handle by-handle and
                  decrypts in the browser for vault members; non-members see a locked chip. */}
              <SecretChip handle={ref.handle} />
            </li>
          ))}
          <li className="text-xs text-muted-foreground">
            {t("panel.secretHandleNote")}
          </li>
        </ul>
      )}
    </Section>
  );
}

/**
 * Editable secret references (ADR-0073, issue #801, manager-only). The manager variant of
 * {@link SecretsSection}: the same handle chips PLUS a remove (×) per ref and an "Attach secret"
 * picker. INV-10 holds throughout — this surface only ever touches HANDLES + labels (metadata), never
 * a value; the per-ref {@link SecretChip} does any reveal client-side, exactly as in the read-only variant.
 *
 * The picker is the shared {@link Combobox} in server-search mode, fed by {@link useHandleSuggestions}
 * — the same member-scoped, value-free handle source the KB editor uses (only the caller's vaults).
 * A handle needs its `vaultId` to attach, so each suggestion is keyed by `${vaultId}:${handle}` and
 * the chosen `{ handle, vaultId }` recovered from the suggestion on select. Already-attached handles
 * are filtered out of the picker (the backend is idempotent anyway). Attach/detach act immediately
 * (no draft) and the node detail refreshes via the hooks' `infraKeys.all` invalidation. Errors —
 * including the API's friendly 403 ("not a member of the vault that holds this secret") — surface via
 * `notifyError`, exactly like the other mutations here.
 */
function SecretsEditor({
  nodeId,
  secretRefs,
}: {
  nodeId: string;
  secretRefs: InfraSecretRef[];
}) {
  const t = useTranslations("infra");
  const attach = useAttachInfraSecret();
  const detach = useDetachInfraSecret();
  const [query, setQuery] = useState("");
  const { data: suggestions, isLoading } = useHandleSuggestions(
    query || undefined,
  );

  const pending = attach.isPending || detach.isPending;

  // Hide handles already attached to this node (idempotent on the server, but no point offering them).
  const attached = new Set(
    secretRefs.map((ref) => `${ref.vaultId}:${ref.handle}`),
  );
  const items: ComboboxItem[] = (suggestions ?? [])
    .map((s) => ({
      value: `${s.vaultId}:${s.handle}`,
      label: s.label,
      // The handle is searchable too (the label is the human title).
      keywords: [s.handle],
    }))
    .filter((item) => !attached.has(item.value));

  function handleAttach(value: string) {
    if (!value) return;
    const chosen = (suggestions ?? []).find(
      (s) => `${s.vaultId}:${s.handle}` === value,
    );
    if (!chosen) return;
    attach.mutate(
      { id: nodeId, handle: chosen.handle, vaultId: chosen.vaultId },
      {
        onSuccess: () => {
          toast.success(t("panel.secretAttachedToast"));
          setQuery("");
        },
        onError: (error) => notifyError(error, t("panel.secretAttachError")),
      },
    );
  }

  function handleDetach(ref: InfraSecretRef) {
    detach.mutate(
      { id: nodeId, handle: ref.handle, vaultId: ref.vaultId },
      {
        onSuccess: () => toast.success(t("panel.secretDetachedToast")),
        onError: (error) => notifyError(error, t("panel.secretDetachError")),
      },
    );
  }

  return (
    <Section title={t("panel.secretsTitle")}>
      {secretRefs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.noSecrets")}</p>
      ) : (
        <ul className="space-y-2">
          {secretRefs.map((ref) => (
            <li key={`${ref.vaultId}:${ref.handle}`} className="space-y-1">
              <div className="flex items-center gap-2">
                <KeyIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate text-sm font-medium">
                  {ref.label}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={t("panel.secretRemove")}
                  disabled={pending}
                  onClick={() => handleDetach(ref)}
                >
                  <XMarkIcon />
                </Button>
              </div>
              {/* Reveal is client-side only (INV-10): SecretChip resolves the handle by-handle and
                  decrypts in the browser for vault members; non-members see a locked chip. */}
              <SecretChip handle={ref.handle} />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 space-y-1.5">
        <Combobox
          value=""
          onValueChange={handleAttach}
          items={items}
          onSearchChange={setQuery}
          loading={isLoading}
          disabled={pending}
          placeholder={t("panel.secretAttach")}
          searchPlaceholder={t("panel.secretPickerSearch")}
          emptyText={t("panel.secretPickerEmpty")}
        />
        <p className="text-xs text-muted-foreground">
          {t("panel.secretHandleNote")}
        </p>
      </div>
    </Section>
  );
}

/** Quick-access links (SSH/web UI/console). Each opens in a new tab; URLs were validated on write. */
function ShortcutsSection({
  shortcuts,
}: {
  shortcuts: InfraShortcut[] | null;
}) {
  const t = useTranslations("infra");
  const list = shortcuts ?? [];
  return (
    <Section title={t("panel.shortcutsTitle")}>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("panel.noShortcuts")}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {list.map((shortcut) => (
            <li key={`${shortcut.label}:${shortcut.url}`}>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={shortcut.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {shortcut.label}
                  <ArrowTopRightOnSquareIcon />
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Nodes hosted on this one (active inverse RUNS_ON). */
function ChildrenSection({ nodes }: { nodes: InfraNodeChild[] }) {
  const t = useTranslations("infra");
  return (
    <Section title={t("panel.childrenTitle")}>
      {nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("panel.noChildren")}</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {nodes.map((child) => (
            <li key={child.id} className="flex items-center gap-2">
              <CubeIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate font-medium">{child.label}</span>
              <span className="text-xs text-muted-foreground">
                {t(`kind.${child.kind}`)}
              </span>
              <StatusBadge
                tone={statusTone(child.status)}
                dot
                className="ml-auto"
              >
                {t(`status.${child.status}`)}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * The remove-from-map control (soft-delete) — a destructive button + the confirm dialog. Keeps the
 * dialog's open-state local; on a confirmed remove it closes the whole modal (the node is off the map).
 */
function RemoveControl({
  label,
  onConfirm,
  onRemoved,
}: {
  label: string;
  onConfirm: () => Promise<unknown>;
  onRemoved: () => void;
}) {
  const t = useTranslations("infra");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <TrashIcon />
        {t("panel.deleteAction")}
      </Button>
      <DeleteNodeDialog
        open={open}
        onOpenChange={setOpen}
        label={label}
        onConfirm={async () => {
          await onConfirm();
          onRemoved();
        }}
      />
    </>
  );
}

/** Loading skeleton mirroring the modal's header + a couple of content blocks. */
function ModalSkeleton({ label }: { label: string }) {
  return (
    <div className="row-span-2 space-y-5 p-5" role="status" aria-label={label}>
      <Skeleton className="h-6 w-2/3 max-w-sm" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
