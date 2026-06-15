"use client";

import { ArrowPathIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { UserKeypair } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";
import { regenerateRecoveryWrap } from "@/lib/secret-manager/crypto";
import { useRegenerateRecoveryKey } from "@/lib/secret-manager/hooks/use-keypair";
import { RecoveryKeyModal } from "./recovery-key-modal";

/**
 * RegenerateRecoveryKeyFlow — re-mint ONLY the recovery key for an EXISTING keypair (ADR-0065, issue #452).
 *
 * The "lost my recovery key, kept my passphrase" path. Unlike a peer-reset (`PUT /keypair/me`), this is
 * NON-destructive: the keypair (public key), the passphrase wrap, the per-vault DEKs, and EVERY membership
 * are untouched — only the recovery-key wrap is replaced. There is no DEK re-wrap and no membership churn.
 *
 * ALWAYS REQUIRE THE PASSPHRASE (ADR-0065 Status resolution 2): the flow re-derives the private key via the
 * passphrase EVERY time, even inside an already-unlocked session — it NEVER reuses an already-in-memory
 * private key from the session. This is the security boundary against a walk-up attacker minting a recovery
 * key on an unattended unlocked session. The unwrapped private key lives only inside `regenerateRecoveryWrap`
 * and is dropped when it returns — it never enters the in-memory session here.
 *
 * INV-10 / ephemeral discipline: the passphrase typed here is held in local state ONLY while the dialog is
 * open and dropped after a successful regen; the new recovery key (and the re-wrapped blob) are produced in
 * the browser; the server stores ONLY the recovery-key-WRAPPED blob; nothing secret is cached, logged, or
 * sent. The new key is shown ONLY AFTER the POST succeeds (post-acknowledge ordering): the new blob is
 * committed server-side FIRST — so the OLD recovery key is already dead — THEN the new key is shown once,
 * and the acknowledge clears it from state. It is never re-fetchable.
 *
 * "View an existing recovery key" is impossible (zero-knowledge — never stored): this is regenerate-only.
 */
export function RegenerateRecoveryKeyFlow({
  keypair,
}: {
  /** The caller's existing keypair (from `GET /keypair/me`). The flow renders only when this exists. */
  keypair: UserKeypair;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const regenerate = useRegenerateRecoveryKey();
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [noKeypair, setNoKeypair] = useState(false);
  // The NEW recovery key, held ONLY while the shown-once modal is up. Set AFTER the POST succeeds; cleared on
  // acknowledge. While non-null, the RecoveryKeyModal is shown (and the passphrase dialog is hidden).
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  function reset() {
    setPassphrase("");
    setBusy(false);
    setFailed(false);
    setNoKeypair(false);
  }

  function handleOpenChange(next: boolean) {
    // While the regen is in flight OR the shown-once modal is up, the dialog must not be dismissible — a
    // stray close would either interrupt an irreversible write or lose the shown-once key.
    if (busy || recoveryKey != null) return;
    setOpen(next);
    if (!next) reset();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setFailed(false);
    setNoKeypair(false);

    // Step 1 — re-derive the private key from the passphrase IN THE BROWSER and re-wrap under a NEW recovery
    // key. ALWAYS via the passphrase (ADR-0065) — never a cached session key. A wrong passphrase throws the
    // generic, payload-free decrypt error BEFORE anything is posted, so a failed attempt mints nothing.
    let wire;
    let recoveryKeyDisplay: string;
    try {
      const result = await regenerateRecoveryWrap(keypair, passphrase);
      wire = result.wire;
      recoveryKeyDisplay = result.recoveryKeyDisplay;
    } catch {
      // Wrong passphrase / tampered blob — friendly inline error, no leak. Drop the entered passphrase.
      setFailed(true);
      setPassphrase("");
      setBusy(false);
      return;
    }

    // Step 2 — COMMIT the new recovery wrap server-side. Only AFTER this succeeds do we show the new key
    // (the old recovery key is now dead). A 404 means the user has no keypair yet — surface the bootstrap-first
    // note; any other API error goes through the shared notify-error toast.
    try {
      await regenerate.mutateAsync(wire);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNoKeypair(true);
      } else {
        notifyError(err, t("regenerateRecovery.error"));
      }
      setPassphrase("");
      setBusy(false);
      return;
    }

    // Persisted — drop the passphrase, then show the NEW recovery key once via the shown-once modal.
    setPassphrase("");
    setBusy(false);
    setRecoveryKey(recoveryKeyDisplay);
  }

  function handleAcknowledge() {
    // The user saved the new key — clear it from state (never re-fetchable) and close the whole flow.
    setRecoveryKey(null);
    setOpen(false);
    reset();
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title={t("regenerateRecovery.triggerHint")}
      >
        <KeyIcon className="size-4" aria-hidden />
        {t("regenerateRecovery.trigger")}
      </Button>

      {/* The passphrase prompt. Hidden while the shown-once RecoveryKeyModal is up (recoveryKey != null). */}
      <Dialog open={open && recoveryKey == null} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyIcon className="size-5 text-pillar-knowledge" aria-hidden />
              {t("regenerateRecovery.title")}
            </DialogTitle>
            <DialogDescription>
              {t("regenerateRecovery.description")}
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
            {t("regenerateRecovery.replaceWarning")}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="regen-recovery-pass">
                {t("regenerateRecovery.passphraseLabel")}
              </FieldLabel>
              <Input
                id="regen-recovery-pass"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setFailed(false);
                  setNoKeypair(false);
                }}
                disabled={busy}
                autoFocus
              />
              <FieldDescription>
                {t("regenerateRecovery.passphraseHint")}
              </FieldDescription>
              {failed ? (
                <FieldDescription className="text-destructive">
                  {t("regenerateRecovery.passphraseFailed")}
                </FieldDescription>
              ) : null}
              {noKeypair ? (
                <FieldDescription className="text-destructive">
                  {t("regenerateRecovery.noKeypair")}
                </FieldDescription>
              ) : null}
            </Field>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={busy}
              >
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={busy || !passphrase}>
                {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
                {busy
                  ? t("regenerateRecovery.regenerating")
                  : t("regenerateRecovery.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Shown-once: the NEW recovery key, displayed ONLY after the POST committed it server-side. */}
      <RecoveryKeyModal
        open={recoveryKey != null}
        recoveryKey={recoveryKey ?? ""}
        onAcknowledge={handleAcknowledge}
      />
    </>
  );
}
