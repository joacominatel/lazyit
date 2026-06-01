"use client";

import {
  ArrowTopRightOnSquareIcon,
  CubeIcon,
  LinkIcon,
  PlusIcon,
  Squares2X2Icon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { type ArticleLink, MAX_PAGE_LIMIT } from "@lazyit/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DetailPanel } from "@/components/detail-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useAssets } from "@/lib/api/hooks/use-assets";
import {
  useArticleLinks,
  useCreateArticleLink,
  useDeleteArticleLink,
} from "@/lib/api/hooks/use-article-links";
import { notifyError } from "@/lib/api/notify-error";

type Target = "asset" | "application";

/**
 * "Linked to" panel on the KB article detail (ADR-0042, #104) — the single WRITE surface for
 * ArticleLinks. Lists the article's forward links (resolving each to its asset/application name and
 * route) and, when the caller can write, offers an inline "+ Link" affordance (a small dialog to
 * pick an asset XOR application) and per-row removal. The reverse "Related articles" panels on the
 * asset/application details are read-only and refetch automatically (shared invalidation key).
 *
 * `canWrite` is gated by the page on `useCanWrite()`; the API additionally enforces author-only.
 */
export function ArticleLinksPanel({
  articleId,
  canWrite,
}: {
  articleId: string;
  canWrite: boolean;
}) {
  const { data: links, isLoading } = useArticleLinks(articleId);
  // Catalogs to resolve a link's FK to a display name + to populate the picker.
  const { data: assetsPage } = useAssets({ limit: MAX_PAGE_LIMIT });
  const { data: applications } = useApplications();
  const removeLink = useDeleteArticleLink();

  const [addOpen, setAddOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const assetById = useMemo(
    () => new Map((assetsPage?.items ?? []).map((a) => [a.id, a.name])),
    [assetsPage],
  );
  const appById = useMemo(
    () => new Map((applications ?? []).map((a) => [a.id, a.name])),
    [applications],
  );

  function targetOf(link: ArticleLink): {
    kind: Target;
    name: string;
    href: string;
  } {
    if (link.assetId) {
      return {
        kind: "asset",
        name: assetById.get(link.assetId) ?? "Asset",
        href: `/assets/${link.assetId}`,
      };
    }
    return {
      kind: "application",
      name: appById.get(link.applicationId ?? "") ?? "Application",
      href: `/applications/${link.applicationId}`,
    };
  }

  function handleRemove(link: ArticleLink) {
    setRemovingId(link.id);
    removeLink.mutate(
      { articleId, linkId: link.id },
      {
        onSuccess: () => {
          toast.success("Link removed");
          setRemovingId(null);
        },
        onError: (error) => {
          notifyError(error, "Couldn't remove the link");
          setRemovingId(null);
        },
      },
    );
  }

  const rows = links ?? [];

  return (
    <DetailPanel
      title="Linked to"
      actions={
        canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            Link
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading links…</p>
      ) : rows.length === 0 ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <LinkIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Not linked to anything yet. Link this article to an asset or
            application to surface it as that record&apos;s runbook.
          </p>
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((link) => {
            const target = targetOf(link);
            const Icon = target.kind === "asset" ? CubeIcon : Squares2X2Icon;
            return (
              <li
                key={link.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <Link
                  href={target.href}
                  className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                >
                  <Icon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate">{target.name}</span>
                  <span className="text-xs font-normal text-muted-foreground capitalize">
                    {target.kind}
                  </span>
                  <ArrowTopRightOnSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </Link>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove link"
                    onClick={() => handleRemove(link)}
                    disabled={removeLink.isPending}
                  >
                    {removingId === link.id ? (
                      <ArrowPathIcon className="animate-spin" />
                    ) : (
                      <TrashIcon />
                    )}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canWrite && (
        <AddArticleLinkDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          articleId={articleId}
          assets={(assetsPage?.items ?? []).map((a) => ({
            id: a.id,
            name: a.name,
          }))}
          applications={(applications ?? []).map((a) => ({
            id: a.id,
            name: a.name,
          }))}
        />
      )}
    </DetailPanel>
  );
}

/** Inline picker dialog to link the article to an asset XOR an application (POST /articles/:id/links). */
function AddArticleLinkDialog({
  open,
  onOpenChange,
  articleId,
  assets,
  applications,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  articleId: string;
  assets: { id: string; name: string }[];
  applications: { id: string; name: string }[];
}) {
  const create = useCreateArticleLink();
  const [target, setTarget] = useState<Target>("asset");
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTarget("asset");
      setTargetId("");
      setError(null);
    }
    onOpenChange(next);
  }

  function handleCreate() {
    if (!targetId) {
      setError("Choose a target to link.");
      return;
    }
    setError(null);
    const data =
      target === "asset"
        ? { assetId: targetId }
        : { applicationId: targetId };
    create.mutate(
      { articleId, data },
      {
        onSuccess: () => {
          toast.success("Article linked");
          handleOpenChange(false);
        },
        onError: (err) => notifyError(err, "Couldn't link the article"),
      },
    );
  }

  const options = target === "asset" ? assets : applications;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link article</DialogTitle>
          <DialogDescription>
            Link this article to an asset or an application so it shows as that
            record&apos;s runbook. A link points to exactly one target.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="link-target-kind">Target type</FieldLabel>
            <Select
              value={target}
              onValueChange={(value) => {
                setTarget(value as Target);
                setTargetId("");
                setError(null);
              }}
            >
              <SelectTrigger id="link-target-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asset">Asset</SelectItem>
                <SelectItem value="application">Application</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="link-target">
              {target === "asset" ? "Asset" : "Application"}
            </FieldLabel>
            <Select
              value={targetId}
              onValueChange={(value) => {
                setTargetId(value);
                if (error) setError(null);
              }}
            >
              <SelectTrigger
                id="link-target"
                className="w-full"
                aria-invalid={error ? true : undefined}
              >
                <SelectValue
                  placeholder={
                    options.length > 0
                      ? `Select an ${target === "asset" ? "asset" : "application"}`
                      : `No ${target === "asset" ? "assets" : "applications"} yet`
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError>{error}</FieldError>
            <FieldDescription>
              Already-linked targets are accepted by the API only once; a
              duplicate link is rejected.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleCreate} disabled={create.isPending}>
            {create.isPending && <ArrowPathIcon className="animate-spin" />}
            Link article
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
