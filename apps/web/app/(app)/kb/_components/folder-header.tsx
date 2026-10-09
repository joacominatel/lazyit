"use client";

import { FolderPlusIcon, LockClosedIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { Folder } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { Breadcrumb, type BreadcrumbItem } from "@/components/breadcrumb";
import { RecordFact, RecordFacts } from "@/components/record-page";
import { Button } from "@/components/ui/button";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { type AccessRulePart, summarizeFolderAccess } from "@/lib/utils/kb-folder-access";
import { articleFolderTrail } from "@/lib/utils/kb-reading";
import { kbFolderHref } from "@/lib/utils/kb-shell-route";
import type { FolderIndex } from "../_lib/use-folder-index";
import { FolderActionsMenu, type FolderPermissions } from "./folder-actions-menu";
import { FolderFormDialog } from "./folder-form-dialog";
import type { FolderWithRules } from "./folder-tree";
import { FolderTile } from "./folder-tile";
import { RestrictionPadlock } from "./restriction-padlock";

/**
 * The folder view's header (#1539): the full breadcrumb path, then a summary card on the record-page
 * frame (ledger §4b) — colour tile, name, description, the actions — over four facts:
 *
 *  - **Who can see** — "Everyone with KB access", or the restriction. A `settings:manage` holder gets
 *    the rules in words ("Only Admins or 3 people", "Only holders of Finance"); everyone else reads the
 *    #1299 `hasAccessRules` flag and sees "Restricted" (or "Restricted · inherited from …").
 *  - **Articles** — the folder's own visible-article count (`articleCount`).
 *  - **Subfolders** — direct children.
 *  - **Last change** — the newest `updatedAt` in the folder (and, with "Include subfolders" on, under
 *    it), from a `limit: 1` read in the default newest-updated order.
 *
 * Actions: "New article here" (`article:write`) opens the editor with this folder preselected;
 * "Subfolder" (`category:write`) creates one inside; "⋯" holds Edit / Move / Access / Delete behind
 * their own gates.
 */
export function FolderHeader({
  folder,
  index,
  includeSubfolders,
}: {
  folder: FolderWithRules;
  index: FolderIndex;
  includeSubfolders: boolean;
}) {
  const t = useTranslations("kb");
  const router = useRouter();
  const search = useSearchParams().toString();
  const { relative, dateTime } = useFormatters();
  const perms: FolderPermissions = {
    isAdmin: useCan("settings:manage"),
    canWrite: useCan("category:write"),
    canDelete: useCan("category:delete"),
  };
  const canWriteArticle = useCan("article:write");
  const [subfolderOpen, setSubfolderOpen] = useState(false);

  const navigate = (folderId: string | null) => router.push(kbFolderHref(search, folderId));

  const breadcrumb = useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = [{ label: t("breadcrumb"), href: "/kb" }];
    const trail = articleFolderTrail(folder.id, index.folders as Folder[]);
    for (const step of trail) {
      items.push(
        step.id === folder.id
          ? { label: step.name }
          : { label: step.name, href: kbFolderHref("", step.id) },
      );
    }
    return items;
  }, [t, folder.id, index.folders]);

  const access = summarizeFolderAccess(folder.id, index.folders);
  const subfolderCount = index.childrenById.get(folder.id)?.length ?? 0;

  const { data: latest } = useArticles({
    categoryId: [folder.id],
    includeSubfolders: includeSubfolders || undefined,
    limit: 1,
  });
  const lastChange = latest?.items[0]?.updatedAt;

  return (
    <div className="space-y-3">
      <Breadcrumb items={breadcrumb} />

      <section className="rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3 p-5">
          <FolderTile folderId={folder.id} size="lg" />
          <div className="min-w-0 flex-1 basis-48 space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight break-words">{folder.name}</h1>
            {folder.description ? (
              <p className="text-sm text-muted-foreground">{folder.description}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {perms.canWrite ? (
              <Button variant="outline" onClick={() => setSubfolderOpen(true)}>
                <FolderPlusIcon />
                {t("folderHeader.subfolder")}
              </Button>
            ) : null}
            {canWriteArticle ? (
              <Button asChild>
                <Link href={`/kb/new?categoryId=${encodeURIComponent(folder.id)}`}>
                  <PlusIcon />
                  {t("folderHeader.newArticleHere")}
                </Link>
              </Button>
            ) : null}
            <FolderActionsMenu
              folder={folder}
              folders={index.folders}
              perms={perms}
              selectedFolderId={folder.id}
              onSelect={navigate}
              triggerClassName="size-9 rounded-lg border border-border"
            />
          </div>
        </div>

        <RecordFacts>
          <RecordFact
            label={t("folderHeader.facts.whoCanSee")}
            value={<AccessValue summary={access} index={index} />}
          />
          <RecordFact
            label={t("folderHeader.facts.articles")}
            mono
            value={folder.articleCount ?? "—"}
          />
          <RecordFact
            label={t("folderHeader.facts.subfolders")}
            mono
            value={subfolderCount}
          />
          <RecordFact
            label={t("folderHeader.facts.lastChange")}
            mono
            value={
              lastChange ? (
                <span title={dateTime(lastChange)}>{relative(lastChange)}</span>
              ) : (
                "—"
              )
            }
          />
        </RecordFacts>
      </section>

      {subfolderOpen ? (
        <FolderFormDialog
          open={subfolderOpen}
          onOpenChange={setSubfolderOpen}
          mode="create"
          parentId={folder.id}
          parentName={folder.name}
        />
      ) : null}
    </div>
  );
}

/** The "Who can see" value — a sentence, with the padlock when the folder is restricted. */
function AccessValue({
  summary,
  index,
}: {
  summary: ReturnType<typeof summarizeFolderAccess>;
  index: FolderIndex;
}) {
  const t = useTranslations("kb");
  if (summary.state === "public") {
    return <span className="font-normal">{t("folderHeader.access.everyone")}</span>;
  }
  if (summary.state === "unknown") {
    return <span className="font-normal text-muted-foreground">—</span>;
  }
  if (summary.state === "inherited") {
    const name = index.folderById.get(summary.ancestorId)?.name ?? "";
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-warning-text">
        <RestrictionPadlock inheritedFrom={name} />
        <span className="truncate">{t("folderHeader.access.inherited", { name })}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-warning-text">
      <LockClosedIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {summary.parts.length === 0 ? (
        <span>{t("access.stateRestricted")}</span>
      ) : (
        <span className="min-w-0">
          {t("folderHeader.access.only")}{" "}
          {summary.parts.map((part, i) => (
            <Fragment key={partKey(part)}>
              {i > 0 ? (
                <span className="font-normal">
                  {i === summary.parts.length - 1
                    ? t("folderHeader.access.orSeparator")
                    : t("folderHeader.access.listSeparator")}
                </span>
              ) : null}
              <AccessPartLabel part={part} />
            </Fragment>
          ))}
        </span>
      )}
    </span>
  );
}

function partKey(part: AccessRulePart): string {
  switch (part.kind) {
    case "role":
      return `role:${part.role}`;
    case "users":
      return "users";
    case "appGrant":
      return `app:${part.applicationId}`;
    case "assetAssignment":
      return `asset:${part.assetId}`;
  }
}

/** One rule in words. App and asset names resolve by id (the editor's own hooks), falling back to "…". */
function AccessPartLabel({ part }: { part: AccessRulePart }) {
  const t = useTranslations("kb");
  switch (part.kind) {
    case "role":
      return <>{t(`access.roleLabel.${part.role}`)}</>;
    case "users":
      return <>{t("folderHeader.access.people", { count: part.count })}</>;
    case "appGrant":
      return <AppGrantLabel applicationId={part.applicationId} />;
    case "assetAssignment":
      return <AssetAssigneesLabel assetId={part.assetId} />;
  }
}

function AppGrantLabel({ applicationId }: { applicationId: string }) {
  const t = useTranslations("kb");
  const { data } = useApplication(applicationId);
  return <>{t("folderHeader.access.appHolders", { name: data?.name ?? "…" })}</>;
}

function AssetAssigneesLabel({ assetId }: { assetId: string }) {
  const t = useTranslations("kb");
  const { data } = useAsset(assetId);
  return <>{t("folderHeader.access.assetAssignees", { name: data?.name ?? "…" })}</>;
}

/**
 * The open folder's direct sub-folders as a row of chips (#1539) — tile, name, article count and the
 * padlock — each opening that folder.
 */
export function SubfolderChips({
  folderId,
  index,
}: {
  folderId: string;
  index: FolderIndex;
}) {
  const t = useTranslations("kb");
  const search = useSearchParams().toString();
  const children = index.childrenById.get(folderId) ?? [];
  if (children.length === 0) return null;
  return (
    <nav aria-label={t("folders.subfoldersLabel")}>
      <ul className="flex flex-wrap gap-2">
        {children.map((child) => {
          const { restriction, ancestorName } = index.restrictionOf(child.id);
          return (
            <li key={child.id} className="min-w-0">
              <Link
                href={kbFolderHref(search, child.id)}
                className={cn(
                  "flex max-w-full items-center gap-2 rounded-lg bg-card py-1.5 pr-3 pl-1.5 text-sm ring-1 ring-foreground/10 outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <FolderTile folderId={child.id} />
                <span className="truncate">{child.name}</span>
                {restriction !== "public" ? (
                  <RestrictionPadlock
                    inheritedFrom={restriction === "inherited" ? (ancestorName ?? "") : null}
                  />
                ) : null}
                {child.articleCount != null ? (
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {child.articleCount}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
