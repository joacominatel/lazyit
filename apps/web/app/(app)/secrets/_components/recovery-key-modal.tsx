"use client";

import { CheckIcon, ClipboardIcon, KeyIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { copyText } from "@/lib/secret-manager/clipboard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * RecoveryKeyModal — shows the recovery key EXACTLY ONCE (ADR-0061 §4, the service-account shown-once
 * precedent), behind an explicit "I've saved it" acknowledgement (INV-10 hard constraint #3).
 *
 * The recovery key is the ONLY second unlock path for the private key (HKDF copy). It is generated in the
 * browser during bootstrap / peer-reset and is NEVER persisted, NEVER sent to the server, NEVER
 * refetchable — the server stores only the recovery-key-WRAPPED blob, which it cannot unwrap. If the user
 * dismisses this without saving it, it is gone. Copy-to-clipboard is offered as a convenience; the value
 * is never logged.
 *
 * The modal is intentionally NON-dismissible by overlay/escape (no close button) — the only way out is
 * the acknowledged "I've saved it" button, so the key can't be lost to a stray click.
 */
export function RecoveryKeyModal({
  open,
  recoveryKey,
  onAcknowledge,
}: {
  open: boolean;
  /** The `XXXXX-XXXXX-…` recovery key to display once. Held only while this modal is mounted. */
  recoveryKey: string;
  /** Called when the user explicitly confirms they've saved the key — the only exit. */
  onAcknowledge: () => void;
}) {
  const t = useTranslations("secrets");
  const [copied, setCopied] = useState(false);
  // SECW-06: the recovery key is the user's ONLY second unlock path. If the clipboard API is
  // unavailable (insecure context — plain-HTTP self-host), Copy must NOT imply success — that could
  // make the user dismiss the shown-once key believing it was saved. Track and surface failure.
  const [copyFailed, setCopyFailed] = useState(false);
  const [acked, setAcked] = useState(false);

  async function handleCopy() {
    // Convenience only — the key is never logged. copyText reports success/failure (it never throws).
    const ok = await copyText(recoveryKey);
    if (ok) {
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      // Insecure context: no clipboard. Surface a manual-copy instruction; the key block is
      // `select-all`, so the user can still select & copy it by hand.
      setCopyFailed(true);
    }
  }

  function handleAck() {
    setAcked(false);
    onAcknowledge();
  }

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyIcon className="size-5 text-pillar-knowledge" />
            {t("recoveryKey.title")}
          </DialogTitle>
          <DialogDescription>{t("recoveryKey.description")}</DialogDescription>
        </DialogHeader>

        {/* The key itself — a monospace, selectable block. */}
        <div className="space-y-3">
          <div className="rounded-lg border border-pillar-knowledge/30 bg-pillar-knowledge/5 p-4">
            <code className="block break-all text-center font-mono text-base font-semibold tracking-wide text-foreground select-all">
              {recoveryKey}
            </code>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleCopy}
          >
            {copied ? <CheckIcon className="size-4" /> : <ClipboardIcon className="size-4" />}
            {copied ? t("recoveryKey.copied") : t("recoveryKey.copy")}
          </Button>
          {/* SECW-06: clipboard unavailable (insecure context). Do NOT imply the key was copied —
              tell the user to copy it manually from the block above (it is `select-all`). */}
          {copyFailed ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {t("recoveryKey.copyFailed")}
            </p>
          ) : null}
          <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
            {t("recoveryKey.warning")}
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded border-input accent-pillar-knowledge"
            />
            <span>{t("recoveryKey.acknowledge")}</span>
          </label>
        </div>

        <DialogFooter>
          <Button type="button" onClick={handleAck} disabled={!acked}>
            {t("recoveryKey.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
