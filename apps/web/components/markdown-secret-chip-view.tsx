"use client";

import {
  EyeIcon,
  KeyIcon,
  LockClosedIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";
import { ApiError } from "@/lib/api/client";
import { useResolvedHandle } from "@/lib/secret-manager/hooks/use-chip";
import { useMyKeypair } from "@/lib/secret-manager/hooks/use-keypair";
import { cn } from "@/lib/utils";

/**
 * The reveal/unlock machinery — `openItem` (crypto.ts → `@noble/*`), `useVaultDek`, and `UnlockGate`
 * (Argon2id via hash-wasm) — is the entire zero-knowledge crypto graph. Loading it through a
 * `next/dynamic({ ssr:false })` boundary keeps it OUT of every KB article/editor route bundle (#494):
 * this shell, statically imported by `markdown-view.tsx`, carries none of it. The chunk is fetched
 * lazily on the user's first "reveal" click and never on the server (the crypto is browser-only).
 */
const SecretChipReveal = dynamic(
  () =>
    import("@/components/markdown-secret-chip-reveal").then((m) => m.SecretChipReveal),
  { ssr: false },
);

/**
 * SecretChip — the inline KB chip for a `{{ lazyit_secret.HANDLE }}` token (ADR-0061 §8).
 *
 * This is the LIGHTWEIGHT SHELL (#494). It resolves the handle (public metadata only) and renders the
 * three "no crypto needed" states — locked / broken / collapsed-metadata — as a static import. Only
 * when a vault member clicks "reveal" does it mount {@link SecretChipReveal}, the dynamically-loaded
 * heavy half that pulls in the crypto graph (decrypt + DEK unwrap + unlock gate).
 *
 * Three rendering states:
 *  - **Locked** (403 from backend): a padlocked chip; reveals NOTHING beyond the handle. The
 *    reader is not a member of the secret's vault — the double gate is enforced by the API.
 *  - **Broken** (404 from backend): a warning chip; the handle has no live secret.
 *  - **Unlockable / revealed**: a key chip. On click it mounts the reveal half, which ensures the
 *    vault DEK (driving the unlock gate when locked), decrypts locally and shows the value inline.
 *
 * SECURITY (ADR-0061 INV-10): no plaintext or crypto lives in this shell; all of it is in the reveal
 * half, which keeps plaintext in local state only, cleared on mask and on unmount.
 */
export function SecretChip({ handle }: { handle?: string }) {
  const t = useTranslations("secrets");

  // SM-WEB-03: detect whether the caller has a keypair yet. A 404 on keypair/me means "never
  // bootstrapped" — in that case the UnlockGate renders the first-run BOOTSTRAP form (incl. the
  // shown-once recovery key), so the dialog header must say "Set up your Secret Manager", NOT the
  // "enter your passphrase" unlock copy. This only reads PUBLIC keypair metadata (no secret).
  const { isError: keypairError, error: keypairErr } = useMyKeypair();
  const isMissingKeypair =
    keypairError && keypairErr instanceof ApiError && keypairErr.status === 404;

  // True once the user has clicked reveal → mount the heavy reveal half. Reset on mask.
  const [revealing, setRevealing] = useState(false);

  // Resolve the handle via the backend. 403 → data is undefined + error.status===403.
  // 404 → error.status===404. Success → { item, membership }.
  const { data: resolved, isLoading, error } = useResolvedHandle(handle);

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

  // Resolved: the caller is a vault member. Render the metadata chip; defer all crypto to the reveal half.
  if (!resolved) return null;
  const { item } = resolved;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ring-1 select-none",
        revealing
          ? "bg-pillar-knowledge/10 ring-pillar-knowledge/30 text-foreground"
          : "bg-muted/60 ring-foreground/10 text-muted-foreground",
      )}
      data-secret-chip="resolved"
    >
      <KeyIcon className="size-3 shrink-0 text-pillar-knowledge" aria-hidden />
      <span className="font-mono">{handle}</span>

      {revealing ? (
        <SecretChipReveal
          item={{
            vaultId: item.vaultId,
            ciphertext: item.ciphertext,
            iv: item.iv,
            authTag: item.authTag,
            keyVersion: item.keyVersion,
          }}
          isMissingKeypair={Boolean(isMissingKeypair)}
          onMasked={() => setRevealing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setRevealing(true)}
          title={t("chip.reveal")}
          aria-label={t("chip.reveal")}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          <EyeIcon className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}
