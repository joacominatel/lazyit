"use client";

import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
  CubeIcon,
  KeyIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type {
  InfraNodeChild,
  InfraNodeDetail,
  InfraNodeOwner,
  InfraNodeStatus,
  InfraSecretRef,
  InfraShortcut,
} from "@lazyit/shared";
import { InfraNodeStatusSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
}: {
  /** The selected node id, or null when nothing is selected (the Sheet is closed). */
  nodeId: string | null;
  /** Called to clear the selection (Sheet dismissed). */
  onClose: () => void;
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
          <PanelSkeleton label={t("panel.loading")} />
        ) : isError || !node ? (
          <div className="p-6">
            <SheetHeader className="p-0">
              <SheetTitle>{t("panel.loadError")}</SheetTitle>
            </SheetHeader>
          </div>
        ) : (
          <PanelBody node={node} canManage={canManage} onClose={onClose} />
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
}: {
  node: InfraNodeDetail;
  canManage: boolean;
  onClose: () => void;
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
        <SheetTitle className="pr-8 text-base">{node.label}</SheetTitle>
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
            <span className="font-medium text-foreground">{node.assetName}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("panel.noInventoryName")}
          </p>
        )}
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Quick facts: IP + added-at. */}
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {t("panel.ipLabel")}
            </dt>
            <dd className={node.ipAddress ? "font-mono" : "text-muted-foreground"}>
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
        <ShortcutsSection shortcuts={node.shortcuts} />
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
