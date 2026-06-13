"use client";

import {
  CheckIcon,
  ClipboardIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  LockClosedIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { copyText } from "@/lib/secret-manager/clipboard";
import { openItem } from "@/lib/secret-manager/crypto";
import { useResolvedHandle } from "@/lib/secret-manager/hooks/use-chip";
import { useMyKeypair } from "@/lib/secret-manager/hooks/use-keypair";
import { useVaultDek } from "@/app/(app)/secrets/_components/use-vault-dek";
import { useSecretSession } from "@/app/(app)/secrets/_components/secret-session";
import { UnlockGate } from "@/app/(app)/secrets/_components/unlock-gate";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** How long (ms) a revealed value stays visible before auto-masking (mirrors vault-detail-content). */
const REVEAL_TIMEOUT_MS = 15_000;

/**
 * SecretChip — the inline KB chip for a `{{ lazyit_secret.HANDLE }}` token (ADR-0061 §8).
 *
 * Three rendering states:
 *  - **Locked** (403 from backend): a padlocked chip; reveals NOTHING beyond the handle. The
 *    reader is not a member of the secret's vault — the double gate is enforced by the API.
 *  - **Broken** (404 from backend): a warning chip; the handle has no live secret.
 *  - **Unlockable / revealed**: a key chip. On click the component ensures the vault DEK is
 *    available (driving the unlock gate via a modal if the session is locked), then decrypts
 *    the value locally, shows it inline, and auto-masks after `REVEAL_TIMEOUT_MS`.
 *
 * SECURITY (ADR-0061 INV-10):
 *  - Plaintext lives ONLY in local state, cleared on mask and on unmount.
 *  - The query key carries the handle (public metadata) ONLY — never a value.
 *  - No value is logged, stored, or put in a query cache.
 *  - The unlock modal is `UnlockGate` behind a `Dialog`; the session is app-wide after the
 *    provider hoist to `(app)/layout.tsx`.
 */
export function SecretChip({ handle }: { handle?: string }) {
  const t = useTranslations("secrets");
  const { isUnlocked } = useSecretSession();

  // SM-WEB-03: detect whether the caller has a keypair yet. A 404 on keypair/me means "never
  // bootstrapped" — in that case the UnlockGate renders the first-run BOOTSTRAP form (incl. the
  // shown-once recovery key), so the dialog header must say "Set up your Secret Manager", NOT the
  // "enter your passphrase" unlock copy. This only reads PUBLIC keypair metadata (no secret).
  const { isError: keypairError, error: keypairErr } = useMyKeypair();
  const isMissingKeypair =
    keypairError && keypairErr instanceof ApiError && keypairErr.status === 404;

  // SECURITY: plaintext in local state only — never a query key, never persisted.
  const [plaintext, setPlaintext] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // SECW-06: a copy attempt failed (insecure context — no navigator.clipboard). Prompt the user to
  // select & copy manually instead of implying success.
  const [copyFailed, setCopyFailed] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleanup the auto-mask timer on unmount — drop the plaintext reference.
  useEffect(() => () => {
    clearTimeout(maskTimerRef.current);
    setPlaintext(undefined);
  }, []);

  // Resolve the handle via the backend. 403 → data is undefined + error.status===403.
  // 404 → error.status===404. Success → { item, membership }.
  const { data: resolved, isLoading, error } = useResolvedHandle(handle);

  // Pull the vault DEK hook only when we have the vaultId (avoid conditional hook order issues by
  // always calling but relying on `resolved` being undefined while loading).
  const vaultId = resolved?.item.vaultId ?? "";
  const { ensureDek } = useVaultDek(vaultId);

  // No handle → inert (shouldn't happen; the transform always sets one).
  if (!handle) return null;

  // Loading state — a skeleton chip while the resolution is in flight.
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground animate-pulse">
        <KeyIcon className="size-3" aria-hidden />
        <span className="font-mono">{handle}</span>
      </span>
    );
  }

  // 403: caller is not a member of this secret's vault → show locked chip; reveal NOTHING.
  const is403 =
    error != null &&
    typeof (error as { status?: number }).status === "number" &&
    (error as { status?: number }).status === 403;

  if (is403) {
    return (
      <span
        title={t("chip.lockedTooltip")}
        className={cn(
          "inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-xs",
          "text-muted-foreground cursor-help select-none",
        )}
        data-secret-chip="locked"
      >
        <LockClosedIcon className="size-3 shrink-0" aria-hidden />
        <span className="font-mono">{handle}</span>
      </span>
    );
  }

  // 404: no live secret with this handle → broken-reference chip.
  const is404 =
    error != null &&
    typeof (error as { status?: number }).status === "number" &&
    (error as { status?: number }).status === 404;

  if (is404 || (!isLoading && !resolved)) {
    return (
      <span
        title={t("chip.brokenTooltip")}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-dashed border-destructive/40 px-1.5 py-0.5 text-xs",
          "text-destructive/70 cursor-help select-none",
        )}
        data-secret-chip="broken"
      >
        <ExclamationTriangleIcon className="size-3 shrink-0" aria-hidden />
        <span className="font-mono">{handle}</span>
      </span>
    );
  }

  // Resolved: the caller is a vault member. Drive the reveal flow.
  if (!resolved) return null;
  const { item } = resolved;

  function handleReveal() {
    if (plaintext !== undefined) {
      // Second click → mask immediately.
      clearTimeout(maskTimerRef.current);
      setPlaintext(undefined);
      return;
    }
    // Ensure the vault DEK is available; if the session is locked, open the unlock gate.
    const dek = ensureDek();
    if (!dek) {
      setUnlockOpen(true);
      return;
    }
    decrypt(dek);
  }

  function decrypt(dek: Uint8Array) {
    try {
      const value = openItem(dek, {
        ciphertext: item.ciphertext,
        iv: item.iv,
        authTag: item.authTag,
        keyVersion: item.keyVersion,
      });
      setPlaintext(value);
      clearTimeout(maskTimerRef.current);
      maskTimerRef.current = setTimeout(() => setPlaintext(undefined), REVEAL_TIMEOUT_MS);
    } catch {
      // Wrong DEK or tampered ciphertext — surface nothing; let the user retry.
      setPlaintext(undefined);
    }
  }

  async function handleCopy() {
    if (!plaintext) return;
    // SECW-06: copyText reports failure (insecure context — no clipboard API) instead of silently
    // no-opping. On failure, surface a "select & copy manually" hint rather than a false success.
    const ok = await copyText(plaintext);
    if (ok) {
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopyFailed(true);
    }
  }

  // After unlock, auto-reveal if the session was just unlocked and the gate closed.
  function handleUnlockClose(open: boolean) {
    setUnlockOpen(open);
    if (!open && isUnlocked) {
      const dek = ensureDek();
      if (dek) decrypt(dek);
    }
  }

  const isRevealed = plaintext !== undefined;

  return (
    <>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ring-1 select-none",
          isRevealed
            ? "bg-pillar-knowledge/10 ring-pillar-knowledge/30 text-foreground"
            : "bg-muted/60 ring-foreground/10 text-muted-foreground",
        )}
        data-secret-chip="resolved"
      >
        <KeyIcon className="size-3 shrink-0 text-pillar-knowledge" aria-hidden />
        <span className="font-mono">{handle}</span>

        {isRevealed ? (
          <>
            <span className="mx-0.5 text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <code className="max-w-[12rem] truncate font-mono select-all text-foreground">
              {plaintext}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              title={t("chip.copy")}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              {copied ? (
                <CheckIcon className="size-3 text-pillar-knowledge" aria-hidden />
              ) : (
                <ClipboardIcon className="size-3" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={handleReveal}
              title={t("chip.hide")}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <EyeSlashIcon className="size-3" aria-hidden />
            </button>
            {/* SECW-06: clipboard unavailable (insecure context) — tell the user to copy manually.
                The value above is `select-all`, so a manual selection still works. */}
            {copyFailed ? (
              <span className="ml-0.5 text-[0.65rem] text-destructive" data-secret-chip-copy-failed>
                {t("chip.copyFailed")}
              </span>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            onClick={handleReveal}
            title={t("chip.reveal")}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <EyeIcon className="size-3" aria-hidden />
          </button>
        )}
      </span>

      {/* Unlock gate dialog — shown when the user clicks reveal while the session is locked.
          SM-WEB-03: the header reflects the ACTUAL gate state. A user with no keypair (404) gets the
          first-run BOOTSTRAP form inside UnlockGate (incl. the shown-once recovery key), so the title
          must read "Set up your Secret Manager", not "enter your passphrase". */}
      <Dialog open={unlockOpen} onOpenChange={handleUnlockClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isMissingKeypair ? t("chip.bootstrapTitle") : t("chip.unlockTitle")}
            </DialogTitle>
            <DialogDescription>
              {isMissingKeypair
                ? t("chip.bootstrapDescription")
                : t("chip.unlockDescription")}
            </DialogDescription>
          </DialogHeader>
          <UnlockGate>
            {/* Once unlocked the gate renders children; close the dialog automatically. */}
            <UnlockSuccess onClose={() => handleUnlockClose(false)} />
          </UnlockGate>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Rendered by `UnlockGate` once the session is unlocked — immediately signals close.
 *
 * SECW-01 / SM-FE-005 / SM-WEB-08: a genuine ONE-SHOT. The parent passes an inline
 * `onClose={() => handleUnlockClose(false)}` that is a new function identity every render, so a
 * `[onClose]`-dep effect could re-fire and trigger a redundant `ensureDek()`/`decrypt()`. We keep the
 * latest `onClose` in a ref (so the call always uses the current closure) and run the effect with a
 * `[]` dep, so it fires exactly once on mount — no redundant re-decrypt.
 */
function UnlockSuccess({ onClose }: { onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    onCloseRef.current();
  }, []);
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      <ArrowPathIcon className="size-4 animate-spin" aria-hidden />
    </div>
  );
}
