"use client";

import {
  ArrowPathIcon,
  CheckIcon,
  ClipboardIcon,
  EyeSlashIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useVaultDek } from "@/app/(app)/secrets/_components/use-vault-dek";
import { useSecretSession } from "@/app/(app)/secrets/_components/secret-session";
import { UnlockGate } from "@/app/(app)/secrets/_components/unlock-gate";
import { copyText } from "@/lib/secret-manager/clipboard";
import { openItem } from "@/lib/secret-manager/crypto";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/** How long (ms) a revealed value stays visible before auto-masking (mirrors vault-detail-content). */
const REVEAL_TIMEOUT_MS = 15_000;

/** The decrypt-able shape carried out of the resolved chip envelope. */
export interface RevealItem {
  vaultId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/**
 * SecretChipReveal — the HEAVY half of the KB secret chip (ADR-0061 §8, INV-10).
 *
 * Split out of `SecretChip` (#494) so the zero-knowledge crypto graph (`@noble/*` via `crypto.ts`,
 * `hash-wasm`/Argon2id via `argon2.ts` reached through `useVaultDek` + `UnlockGate`) is pulled in ONLY
 * through a `next/dynamic({ ssr:false })` boundary at the call site — never statically bundled into
 * every KB article/editor route. The lightweight chip shell (locked/broken/metadata states) stays a
 * static import; this module loads on the user's first "reveal" click.
 *
 * It owns the full reveal UX inline: ensure the vault DEK (driving the unlock gate modal when the
 * session is locked), decrypt locally, show the value inline, auto-mask after `REVEAL_TIMEOUT_MS`,
 * and copy. Mounted in the revealed state by the shell, so it decrypts on mount.
 *
 * SECURITY (INV-10): plaintext lives ONLY in local state, cleared on mask and on unmount; never a query
 * key, never persisted, never logged.
 */
export function SecretChipReveal({
  item,
  isMissingKeypair,
  onMasked,
}: {
  item: RevealItem;
  /** True when the caller has no keypair yet (404) — the gate shows the first-run bootstrap form. */
  isMissingKeypair: boolean;
  /** Called when the value is masked again, so the shell can return to its collapsed reveal affordance. */
  onMasked: () => void;
}) {
  const t = useTranslations("secrets");
  const { isUnlocked } = useSecretSession();
  const { ensureDek } = useVaultDek(item.vaultId);

  // SECURITY: plaintext in local state only — never a query key, never persisted.
  const [plaintext, setPlaintext] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // SECW-06: a copy attempt failed (insecure context — no navigator.clipboard). Prompt the user to
  // select & copy manually instead of implying success.
  const [copyFailed, setCopyFailed] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
      maskTimerRef.current = setTimeout(() => mask(), REVEAL_TIMEOUT_MS);
    } catch {
      // Wrong DEK or tampered ciphertext — surface nothing; collapse back to the shell.
      mask();
    }
  }

  function mask() {
    clearTimeout(maskTimerRef.current);
    setPlaintext(undefined);
    onMasked();
  }

  // Decrypt on mount: the shell mounts this component on the reveal click. If the session is locked
  // (no DEK yet), open the unlock gate instead of decrypting.
  const onMaskedRef = useRef(onMasked);
  onMaskedRef.current = onMasked;
  useEffect(() => {
    const dek = ensureDek();
    if (dek) {
      decrypt(dek);
    } else {
      setUnlockOpen(true);
    }
    return () => {
      clearTimeout(maskTimerRef.current);
      setPlaintext(undefined);
    };
    // Mount-only: ensureDek/decrypt are stable enough for a one-shot; re-running would re-decrypt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // After unlock, auto-decrypt if the session was just unlocked and the gate closed; otherwise the
  // user dismissed the gate without unlocking → collapse back to the shell.
  function handleUnlockClose(open: boolean) {
    setUnlockOpen(open);
    if (open) return;
    if (isUnlocked) {
      const dek = ensureDek();
      if (dek) {
        decrypt(dek);
        return;
      }
    }
    mask();
  }

  return (
    <>
      {plaintext !== undefined ? (
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
            aria-label={t("chip.copy")}
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
            onClick={mask}
            title={t("chip.hide")}
            aria-label={t("chip.hide")}
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
        // Locked-session interim: decryption is pending the unlock gate. A tiny spinner keeps the
        // chip from looking inert while the modal is open.
        <ArrowPathIcon className="size-3 animate-spin text-muted-foreground" aria-hidden />
      )}

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
