"use client";

import { ArrowPathIcon, LinkIcon, LinkSlashIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { AssetCombobox } from "@/components/asset-combobox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/api/notify-error";
import { useInvalidateAssets } from "@/lib/api/hooks/use-assets";
import { useUpdateInfraNode } from "@/lib/api/hooks/use-infra-nodes";
import { detachOutcome, detachPermitted } from "./detach-outcome";

/**
 * The node↔asset link control in the drill-in (issue #1202) — the affordance the Manual has promised
 * since ADR-0070 §5 and the UI never offered.
 *
 * The API has shipped the whole contract since #1117: `PATCH /infra/nodes/:id` with `assetId: null`
 * detaches, with a cuid attaches, and re-pointing an already-linked node is a deliberate 400. Every
 * `useUpdateInfraNode` call site in web patched `label`/`kind`/`status`/`ipAddress`/`shortcuts` and
 * nothing else, so four separate Manual passages described a procedure an operator could not perform
 * — and ADR-0093 §8.5's duplicate-suspicion notice pointed at a remediation with no path in the
 * product. This is that path.
 *
 * **The two detach branches are the whole point, and they are shown apart.** Detaching an Asset lazyit
 * minted SOFT-DELETES it; detaching one a human curated only un-links it. A single generic "are you
 * sure?" over both is the defect, not the fix, so the dialog changes its title, its body, its tone and
 * its button per {@link detachOutcome} — destructive red when an inventory row is about to be archived,
 * neutral (the `ConsequentialConfirmDialog` mold) when nothing but the link is going away.
 *
 * **The destructive copy never claims plain reversibility.** It is thinner than it looks:
 * `POST /assets/:id/restore` costs `asset:delete` and the archived slice of the Assets list is
 * admin-only, so a role holding `infra:manage` alone can archive a row it can then neither see nor
 * restore; and a restore does not re-link the node either way. The dialog therefore names the archive,
 * names who can undo it, and says the link is not restored with it — rather than implying an undo the
 * operator standing there may not have.
 *
 * Rendered behind `infra:manage` by the caller, which is how the API gates this route. Since #1202 the
 * ARCHIVING arm costs one permission more — the server AND-checks `asset:delete` when the current link
 * carries the auto-created marker, because that detach soft-deletes an inventory row and every other
 * route in the app charges `asset:delete` for that. So this control takes a SECOND gate, and applies it
 * per arm rather than to the whole control: a role holding `infra:manage` alone must still be able to
 * detach an asset a human curated (that only removes the link), and must not be handed an enabled
 * button for the archive it cannot perform. The decision itself is {@link detachPermitted}.
 *
 * The re-point rule is deliberately NOT re-implemented client-side: the attach arm only ever renders
 * for a node carrying no asset, and if a race lands one anyway the server's 400 surfaces verbatim
 * through `notifyError` — it already names the remedy better than a duplicated client rule would.
 */
export function NodeAssetControl({
  nodeId,
  assetId,
  assetName,
  assetAutoCreated,
  canArchiveAssets,
}: {
  nodeId: string;
  /** The currently linked Asset, or null for a graph-only node. */
  assetId: string | null;
  /** That Asset's inventory name, for the confirmation copy. */
  assetName: string | null;
  /** `InfraNodeDetail.assetAutoCreated` — which detach this link would run. */
  assetAutoCreated: boolean | null | undefined;
  /**
   * Whether the caller holds `asset:delete` (#1202). Only the ARCHIVING detach consults it; attaching
   * and un-linking are unaffected, which is why it is a prop on the control rather than a gate around
   * it. Passed down instead of read here so this file stays free of permission plumbing.
   */
  canArchiveAssets: boolean;
}) {
  const t = useTranslations("infra");
  return assetId ? (
    <DetachControl
      nodeId={nodeId}
      assetName={assetName ?? t("panel.assetLink.unnamedAsset")}
      assetAutoCreated={assetAutoCreated}
      canArchiveAssets={canArchiveAssets}
    />
  ) : (
    <AttachControl nodeId={nodeId} />
  );
}

/** The linked state: a detach button plus the branch-aware confirmation. */
function DetachControl({
  nodeId,
  assetName,
  assetAutoCreated,
  canArchiveAssets,
}: {
  nodeId: string;
  assetName: string;
  assetAutoCreated: boolean | null | undefined;
  canArchiveAssets: boolean;
}) {
  const t = useTranslations("infra");
  const tc = useTranslations("common");
  const updateNode = useUpdateInfraNode();
  const invalidateAssets = useInvalidateAssets();
  const [open, setOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);

  // `null`/absent resolves to "archives" — the cautious arm. An older API omits the field and a
  // vanished Asset row reports null; neither is a licence to promise that nothing will be deleted.
  const outcome = detachOutcome(assetAutoCreated);
  const archives = outcome === "archives";
  // The #1202 second gate, applied to the ARCHIVING arm only. `false` here is the exact request the
  // server now answers with a 403, so the button is disabled rather than left to fail on click — and
  // the un-link arm is untouched, so `infra:manage` alone still detaches a curated asset.
  const permitted = detachPermitted(outcome, canArchiveAssets);

  async function handleDetach() {
    setIsPending(true);
    try {
      await updateNode.mutateAsync({ id: nodeId, patch: { assetId: null } });
      // `useUpdateInfraNode` invalidates `infraKeys.all` only. On the archiving arm an ASSET was
      // soft-deleted too, so the assets lists/detail (and the dashboard counts derived from them)
      // are stale until this fires — without it the operator detaches and still sees the row.
      if (archives) invalidateAssets();
      toast.success(
        archives
          ? t("panel.assetLink.detachedArchivedToast")
          : t("panel.assetLink.detachedToast"),
      );
      setOpen(false);
    } catch (error) {
      // Stays OPEN on failure (the house pattern): the operator keeps the context they were reading.
      notifyError(error, t("panel.assetLink.detachError"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <>
      <div className="space-y-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={!permitted}
        >
          <LinkSlashIcon />
          {t("panel.assetLink.detachAction")}
        </Button>
        {/* The outcome is stated BEFORE the dialog too, so the button is never a blind click — and
            when the archive is out of reach, the reason replaces the hint rather than sitting next to
            a dead button. Disabled + explained, not hidden: the operator needs to know the link
            exists and what it would take to break it, so they can ask for the right permission. */}
        <p className="text-xs text-muted-foreground">
          {!permitted
            ? t("panel.assetLink.detachBlockedArchives")
            : archives
              ? t("panel.assetLink.detachHintArchives")
              : t("panel.assetLink.detachHintUnlinks")}
        </p>
      </div>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archives
                ? t("panel.assetLink.confirmArchiveTitle")
                : t("panel.assetLink.confirmUnlinkTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archives
                ? t("panel.assetLink.confirmArchiveBody", { name: assetName })
                : t("panel.assetLink.confirmUnlinkBody", { name: assetName })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* The archiving arm carries the part that is easy to get wrong: the undo is admin-gated
              and does not re-link the node. Its own block, so it reads as a consequence rather than
              as small print at the end of a sentence. */}
          {archives ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-muted-foreground">
              {t("panel.assetLink.confirmArchiveRestoreNote")}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>
              {tc("cancel")}
            </AlertDialogCancel>
            {/* A plain `Button`, never `AlertDialogAction` — the caller owns the spinner and the
                close, so a failure leaves the dialog standing. Destructive variant ONLY on the arm
                that actually destroys something; the un-link arm stays neutral on purpose. */}
            <Button
              variant={archives ? "destructive" : "default"}
              onClick={() => void handleDetach()}
              disabled={isPending}
            >
              {isPending && <ArrowPathIcon className="animate-spin" />}
              {archives
                ? t("panel.assetLink.confirmArchiveSubmit")
                : t("panel.assetLink.confirmUnlinkSubmit")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The unlinked state: pick a live Asset and attach it. Only ever rendered for a node carrying none,
 * which is the only shape the API accepts — a re-point is the #1117 400 and stays one.
 */
function AttachControl({ nodeId }: { nodeId: string }) {
  const t = useTranslations("infra");
  const updateNode = useUpdateInfraNode();
  const [assetId, setAssetId] = useState("");

  function handleAttach() {
    if (!assetId) return;
    updateNode.mutate(
      { id: nodeId, patch: { assetId } },
      {
        onSuccess: () => {
          toast.success(t("panel.assetLink.attachedToast"));
          setAssetId("");
        },
        // The server's 404 (missing/discarded asset) and its 400 (re-point) surface VERBATIM: both
        // already name the remedy, and re-deriving either client-side would be a second copy of a
        // rule that lives in `InfraService.updateNode`.
        onError: (error) => notifyError(error, t("panel.assetLink.attachError")),
      },
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {t("panel.assetLink.attachHint")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <AssetCombobox
            value={assetId}
            onValueChange={setAssetId}
            disabled={updateNode.isPending}
            placeholder={t("panel.assetLink.attachPlaceholder")}
          />
        </div>
        <Button
          size="sm"
          onClick={handleAttach}
          disabled={!assetId || updateNode.isPending}
        >
          {updateNode.isPending && <ArrowPathIcon className="animate-spin" />}
          <LinkIcon />
          {t("panel.assetLink.attachAction")}
        </Button>
      </div>
    </div>
  );
}
