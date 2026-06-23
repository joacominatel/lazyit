"use client";

import {
  ArrowTopRightOnSquareIcon,
  BoltIcon,
  BookOpenIcon,
  CheckIcon,
  CubeIcon,
  KeyIcon,
  PencilSquareIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type {
  InfraImpactResponse,
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
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  useDeleteInfraNode,
  useInfraNodeDetail,
  useUpdateInfraNode,
} from "@/lib/api/hooks/use-infra-nodes";
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { statusTone } from "@/lib/infra/canvas";
import { DeleteNodeDialog } from "./delete-node-dialog";
import { NodeEdgesManager } from "./node-edges-manager";

const STATUS_OPTIONS = InfraNodeStatusSchema.options;
const KIND_OPTIONS = InfraNodeKindSchema.options;

/**
 * The drill-in panel (ADR-0070 §6, issue #742) — the whole reason this beats a Draw.io diagram. A
 * right-side Sheet that opens when a node is selected on the canvas (`onSelectNode` seam from #741),
 * surfacing the asset-backed payoff: owner(s), KB links, secret HANDLES (never values — INV-10),
 * shortcuts, IP, added-at and the children list (active inverse RUNS_ON), plus the node's connections.
 *
 * `label` is the title (the canvas display name always wins); `assetName` is the secondary inventory
 * name. Write controls (status toggle, edge create/close, remove-from-map) are gated on `infra:manage`
 * — read-only viewers see the same facts without the affordances (so the API never 403s on a render).
 */
export function InfraNodePanel({
  nodeId,
  onClose,
  impactOn,
  onToggleImpact,
  impact,
  impactLoading,
}: {
  /** The selected node id, or null when nothing is selected (the Sheet is closed). */
  nodeId: string | null;
  /** Called to clear the selection (Sheet dismissed). */
  onClose: () => void;
  /** Whether blast-radius mode is on for this node (ADR-0070 §7, issue #755). */
  impactOn: boolean;
  /** Toggle blast-radius mode for the selected node. */
  onToggleImpact: () => void;
  /** The blast-radius result (root + affected set) — present only while impact mode is on. */
  impact: InfraImpactResponse | undefined;
  /** Whether the impact query is in flight. */
  impactLoading: boolean;
}) {
  const t = useTranslations("infra");
  const canManage = useCan("infra:manage");
  const { data: node, isLoading, isError } = useInfraNodeDetail(nodeId);

  return (
    <Sheet open={nodeId !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Default (modal) sheet behaviour is correct here: the canvas owns pointer interactions, and a
          non-modal sheet would let a stray canvas click dismiss the panel mid-read. */}
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        {isLoading ? (
          // Radix requires a DialogTitle (here SheetTitle) in EVERY content branch for screen
          // readers (issue #762). The skeleton has no visible title, so we give it an sr-only one.
          <>
            <SheetHeader className="sr-only">
              <SheetTitle>{t("panel.loading")}</SheetTitle>
              <SheetDescription>{t("panel.loading")}</SheetDescription>
            </SheetHeader>
            <PanelSkeleton label={t("panel.loading")} />
          </>
        ) : isError || !node ? (
          <div className="p-6">
            <SheetHeader className="p-0">
              <SheetTitle>{t("panel.loadError")}</SheetTitle>
              <SheetDescription className="sr-only">
                {t("panel.loadError")}
              </SheetDescription>
            </SheetHeader>
          </div>
        ) : (
          <PanelBody
            node={node}
            canManage={canManage}
            onClose={onClose}
            impactOn={impactOn}
            onToggleImpact={onToggleImpact}
            impact={impact}
            impactLoading={impactLoading}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The loaded panel. Split out so hooks here only run once a node has resolved. */
function PanelBody({
  node,
  canManage,
  onClose,
  impactOn,
  onToggleImpact,
  impact,
  impactLoading,
}: {
  node: InfraNodeDetail;
  canManage: boolean;
  onClose: () => void;
  impactOn: boolean;
  onToggleImpact: () => void;
  impact: InfraImpactResponse | undefined;
  impactLoading: boolean;
}) {
  const t = useTranslations("infra");
  const { date } = useFormatters();
  const tone = statusTone(node.status);
  const updateNode = useUpdateInfraNode();
  const deleteNode = useDeleteInfraNode();

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
    <>
      <SheetHeader className="gap-2 border-b">
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
          <SheetTitle className="pr-8 text-base">{node.label}</SheetTitle>
        )}
        <SheetDescription className="sr-only">
          {t(`kind.${node.kind}`)}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{t(`kind.${node.kind}`)}</Badge>
          <StatusBadge tone={tone} dot>
            {t(`status.${node.status}`)}
          </StatusBadge>
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
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Details — the editable config, grouped near the TOP so operators find it where they expect
            (issue #764). Editable on `canManage`; read-only viewers get plain quick-facts instead. */}
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
          </dl>
        )}

        {/* Impact / blast radius (ADR-0070 §7, issue #755) — the query that justifies a graph. The
            toggle drives the canvas highlight (state lives in diagram-view); this surfaces the count
            + list. Shown to every reader (the API gates on infra:read). */}
        <ImpactSection
          impactOn={impactOn}
          onToggleImpact={onToggleImpact}
          impact={impact}
          impactLoading={impactLoading}
        />

        {/* Status toggle (write — gated). */}
        {canManage ? (
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
        ) : null}

        <Separator />

        <OwnersSection owners={node.owners} />
        <ArticlesSection articles={node.articleLinks} />
        <SecretsSection secretRefs={node.secretRefs} />
        {canManage ? (
          <ShortcutsEditor
            key={`${node.id}:${JSON.stringify(node.shortcuts ?? [])}`}
            nodeId={node.id}
            shortcuts={node.shortcuts}
          />
        ) : (
          <ShortcutsSection shortcuts={node.shortcuts} />
        )}
        <ChildrenSection nodes={node.children} />

        <Separator />

        <NodeEdgesManager
          nodeId={node.id}
          nodeLabel={node.label}
          canManage={canManage}
        />

        {/* Lifecycle: remove from map (soft-delete, restorable). */}
        {canManage ? (
          <>
            <Separator />
            <RemoveControl
              label={node.label}
              onConfirm={() => deleteNode.mutateAsync(node.id)}
              onRemoved={onClose}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

/** A titled panel section with the app's small uppercase label. */
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
 * Click-to-rename panel title (issue #764, manager-only). Reads as the plain `SheetTitle` until
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
      <SheetTitle asChild className="pr-8 text-base">
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
      </SheetTitle>
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
      className="h-8 text-base font-semibold"
    />
  );
}

/**
 * The editable Details block (issue #764, manager-only): kind (a `Select`) + IP (an inline input).
 * Grouped near the TOP of the panel so config sits where an operator expects it. Each field patches
 * the node on its own via `useUpdateInfraNode` — optimistic through the shared query invalidation, so
 * the canvas card re-renders live. The added-on date stays read-only (it isn't editable).
 */
function DetailsSection({ node }: { node: InfraNodeDetail }) {
  const t = useTranslations("infra");
  const { date } = useFormatters();
  const updateNode = useUpdateInfraNode();

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

/**
 * Inline IP field (issue #764): plain text until edited, commits on blur/Enter, cancels on Esc.
 * An empty value clears the IP (`ipAddress: null`, which the shared schema allows). Mirrors the
 * rename pattern — minimal, non-animated, one patch per save.
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

/**
 * Impact / blast radius (ADR-0070 §7, issue #755). A toggle that asks the headline graph question —
 * "if this node goes down, what's affected?" — and, when on, surfaces the count + the affected list
 * (label + kind + status + hop depth) while the canvas highlights the same set. An empty result is
 * the *good* news, so it reads as reassurance ("safe to take down"), never a scary empty state.
 */
function ImpactSection({
  impactOn,
  onToggleImpact,
  impact,
  impactLoading,
}: {
  impactOn: boolean;
  onToggleImpact: () => void;
  impact: InfraImpactResponse | undefined;
  impactLoading: boolean;
}) {
  const t = useTranslations("infra");
  const affected = impact?.affected ?? [];
  const count = affected.length;
  // Shallowest first, then alphabetical — the immediate blast radius reads before the transitive tail.
  const ordered = [...affected].sort(
    (a, b) => a.depth - b.depth || a.label.localeCompare(b.label),
  );

  return (
    <Section title={t("panel.impactTitle")}>
      <Button
        variant={impactOn ? "default" : "outline"}
        size="sm"
        className="w-full"
        onClick={onToggleImpact}
        aria-pressed={impactOn}
      >
        <BoltIcon />
        {impactOn ? t("panel.impactHide") : t("panel.impactShow")}
      </Button>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t("panel.impactDescription")}
      </p>

      {impactOn ? (
        impactLoading ? (
          <div className="mt-3 space-y-2" role="status">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : count === 0 ? (
          // Empty = reassuring, not alarming (ADR-0070 §7).
          <div className="mt-3 flex items-start gap-2 rounded-md border border-success/40 bg-success/5 p-3 text-sm text-success">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t("panel.impactSafe")}</span>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm font-medium text-destructive">
              {t("panel.impactCount", { count })}
            </p>
            <ul className="space-y-1.5 text-sm">
              {ordered.map((item) => (
                <li key={item.id} className="flex items-center gap-2">
                  <CubeIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate font-medium">{item.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(`kind.${item.kind}`)}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {t("panel.impactDepth", { depth: item.depth })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
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
                      <Badge variant="outline" className="text-muted-foreground">
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
 * masked mono chip with a label; there is NO reveal/fetch affordance — the array is empty in v1
 * (no asset→secret linkage exists yet) but the shape is honoured so a future linkage just populates it.
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
                <span className="truncate text-sm font-medium">{ref.label}</span>
              </div>
              {/* The handle is a reference token, never the secret material — render it verbatim. */}
              <code className="block truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                {`{{ lazyit_secret.${ref.handle} }}`}
              </code>
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
        <p className="text-sm text-muted-foreground">{t("panel.noShortcuts")}</p>
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
              <StatusBadge tone={statusTone(child.status)} dot className="ml-auto">
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
 * dialog's open-state local; on a confirmed remove it closes the whole panel (the node is off the map).
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

/** Loading skeleton mirroring the panel's header + a few section blocks. */
function PanelSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-5 p-4" role="status" aria-label={label}>
      <Skeleton className="h-6 w-2/3" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
