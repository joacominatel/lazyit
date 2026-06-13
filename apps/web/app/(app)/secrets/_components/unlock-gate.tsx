"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  LockOpenIcon,
} from "@heroicons/react/24/outline";
import type { UserKeypair } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";
import { useCreateKeypair, useMyKeypair, useResetKeypair } from "@/lib/secret-manager/hooks/use-keypair";
import {
  bootstrapKeypair,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from "@/lib/secret-manager/crypto";
import { RecoveryKeyModal } from "./recovery-key-modal";
import { useSecretSession } from "./secret-session";

/**
 * UnlockGate — the session unlock + first-time bootstrap + recovery boundary (ADR-0061 §3/§4/§6).
 *
 * It decides which of three things to render:
 *   1. NO keypair yet (404 on `keypair/me`) → the BOOTSTRAP flow: pick a vault passphrase →
 *      `bootstrapKeypair` (browser) → POST via `useCreateKeypair` → show the recovery key ONCE.
 *   2. Keypair exists but the session is LOCKED → the UNLOCK flow: passphrase (Argon2id) OR the
 *      "I lost my passphrase" recovery-key path; plus a peer-reset entry for a fully-lost identity.
 *   3. Session UNLOCKED → render {@link children} (the private key is in memory).
 *
 * ALL crypto runs in the browser here (this component is only ever loaded under the `ssr:false`
 * boundary). The passphrase, the recovery key, and the derived private key are EPHEMERAL: the private
 * key goes straight into the in-memory session and the local string state is dropped; nothing secret is
 * cached, logged, or sent.
 *
 * When `embedded` is true, the inner card shell (bg-card, p-8, ring) is suppressed so the flow
 * renders cleanly inside an existing Dialog or card container without double-wrapping.
 */
export function UnlockGate({
  children,
  embedded = false,
}: {
  children: React.ReactNode;
  embedded?: boolean;
}) {
  const { isUnlocked } = useSecretSession();
  const { data: keypair, isLoading, isError, error } = useMyKeypair();

  // A 404 on keypair/me means "this user has never bootstrapped" — the expected first-time path, not an
  // error. Any other failure is a real error surface.
  const isMissing = isError && error instanceof ApiError && error.status === 404;

  if (isLoading) {
    return <UnlockSkeleton embedded={embedded} />;
  }

  if (isUnlocked) {
    return <>{children}</>;
  }

  if (isMissing) {
    return <BootstrapFlow embedded={embedded} />;
  }

  if (isError || !keypair) {
    return <UnlockError embedded={embedded} />;
  }

  return <UnlockFlow keypair={keypair} embedded={embedded} />;
}

function cardCn(embedded: boolean) {
  return embedded
    ? "flex flex-col items-center gap-4 text-center"
    : "mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl bg-card p-8 text-center ring-1 ring-foreground/10";
}

function UnlockSkeleton({ embedded = false }: { embedded?: boolean }) {
  return (
    <div className={cardCn(embedded)}>
      <ArrowPathIcon className="size-6 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}

function UnlockError({ embedded = false }: { embedded?: boolean }) {
  const t = useTranslations("secrets");
  return (
    <div className={embedded ? "flex flex-col items-center gap-3 text-center" : "mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl bg-card p-8 text-center ring-1 ring-foreground/10"}>
      <ExclamationTriangleIcon className="size-8 text-destructive" aria-hidden />
      <p className="text-sm text-muted-foreground">{t("unlock.loadError")}</p>
    </div>
  );
}

/**
 * The LOCKED state: a member who has a keypair must enter their vault passphrase to unlock the private
 * key into the in-memory session. A secondary "I lost my passphrase" toggle swaps to the recovery-key
 * input; a "I lost both" link starts a peer-reset.
 */
function UnlockFlow({ keypair, embedded = false }: { keypair: UserKeypair; embedded?: boolean }) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { setPrivateKey } = useSecretSession();
  const [mode, setMode] = useState<"passphrase" | "recovery" | "reset">("passphrase");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!secret || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const privateKey =
        mode === "recovery"
          ? await unlockWithRecoveryKey(keypair, secret)
          : await unlockWithPassphrase(keypair, secret);
      setSecret(""); // drop the entered secret from local state immediately
      setPrivateKey(privateKey);
    } catch {
      // The crypto layer throws a generic, payload-free decrypt error on a wrong passphrase/recovery key.
      // Never surface the raw error (it carries no secret, but keep the discipline) — just a friendly note.
      setFailed(true);
      setSecret("");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "reset") {
    return <PeerResetFlow onCancel={() => setMode("passphrase")} embedded={embedded} />;
  }

  const isRecovery = mode === "recovery";

  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-md space-y-5 rounded-xl bg-card p-8 ring-1 ring-foreground/10"}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-pillar-knowledge/10">
          <LockClosedIcon className="size-6 text-pillar-knowledge" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{t("unlock.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {isRecovery ? t("unlock.recoveryDescription") : t("unlock.description")}
        </p>
      </div>

      <form onSubmit={handleUnlock} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="unlock-secret">
            {isRecovery ? t("unlock.recoveryKeyLabel") : t("unlock.passphraseLabel")}
          </FieldLabel>
          <Input
            id="unlock-secret"
            type={isRecovery ? "text" : "password"}
            autoComplete="off"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setFailed(false);
            }}
            disabled={busy}
            placeholder={isRecovery ? "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" : undefined}
            autoFocus
          />
          {failed ? (
            <FieldDescription className="text-destructive">
              {isRecovery ? t("unlock.recoveryFailed") : t("unlock.passphraseFailed")}
            </FieldDescription>
          ) : null}
        </Field>

        <Button type="submit" className="w-full" disabled={busy || !secret}>
          {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : <LockOpenIcon className="size-4" />}
          {busy ? t("unlock.unlocking") : t("unlock.submit")}
        </Button>
      </form>

      <div className="flex flex-col items-center gap-1 border-t pt-4 text-center text-xs">
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => {
            setMode(isRecovery ? "passphrase" : "recovery");
            setSecret("");
            setFailed(false);
          }}
        >
          {isRecovery ? t("unlock.usePassphrase") : t("unlock.lostPassphrase")}
        </button>
        <button
          type="button"
          className="text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setMode("reset")}
        >
          {t("unlock.lostBoth")}
        </button>
      </div>
    </div>
  );
}

/**
 * BOOTSTRAP: a brand-new user picks a vault passphrase, the browser mints a keypair (`bootstrapKeypair`),
 * posts the wrapped material, and the recovery key is shown ONCE. On acknowledge, we unlock the freshly
 * created keypair straight into the session (re-deriving from the passphrase the user just typed) so they
 * land inside the manager already unlocked.
 */
function BootstrapFlow({ embedded = false }: { embedded?: boolean }) {
  const t = useTranslations("secrets");
  const { setPrivateKey } = useSecretSession();
  const createKeypair = useCreateKeypair();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  // The wire keypair returned by the POST, used to unlock into the session after acknowledge.
  const [createdKeypair, setCreatedKeypair] = useState<UserKeypair | null>(null);
  // SECW-04: if the post-acknowledge auto-unlock throws, we must NOT wipe the form back to blank —
  // the IRREVERSIBLE keypair already exists. We keep it + the passphrase and surface a recovery view.
  const [unlockFailed, setUnlockFailed] = useState(false);

  const mismatch = confirm.length > 0 && passphrase !== confirm;
  const tooShort = passphrase.length > 0 && passphrase.length < 8;

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !passphrase || passphrase !== confirm || passphrase.length < 8) return;
    setBusy(true);
    try {
      const { wire, recoveryKeyDisplay } = await bootstrapKeypair(passphrase);
      const created = await createKeypair.mutateAsync(wire);
      setCreatedKeypair(created);
      setRecoveryKey(recoveryKeyDisplay); // shown once via the modal
    } catch (err) {
      notifyError(err, t("bootstrap.error"));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcknowledge() {
    // The recovery key has been saved & acknowledged. Unlock the new keypair into the session using the
    // passphrase the user just typed. ONLY drop local secret state once the unlock actually succeeds —
    // otherwise an unlock failure here would strand the user with an irreversible keypair they can't reach.
    const pass = passphrase;
    setRecoveryKey(null);
    if (!createdKeypair) {
      setPassphrase("");
      setConfirm("");
      return;
    }
    try {
      const privateKey = await unlockWithPassphrase(createdKeypair, pass);
      setPrivateKey(privateKey);
      // Success — now it is safe to drop the local secret state.
      setPassphrase("");
      setConfirm("");
      setCreatedKeypair(null);
      setUnlockFailed(false);
    } catch {
      // Keep the created keypair + passphrase; show the "created — unlock with your passphrase" view.
      setUnlockFailed(true);
    }
  }

  // Post-acknowledge recovery: the keypair exists but auto-unlock failed. Let the user re-enter and
  // re-submit their passphrase to unlock the already-created keypair — never back to a blank bootstrap form.
  async function handleRetryUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !passphrase || !createdKeypair) return;
    setBusy(true);
    try {
      const privateKey = await unlockWithPassphrase(createdKeypair, passphrase);
      setPrivateKey(privateKey);
      setPassphrase("");
      setConfirm("");
      setCreatedKeypair(null);
      setUnlockFailed(false);
    } catch {
      // Wrong passphrase — keep the recovery view up so they can try again.
      setUnlockFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (unlockFailed && createdKeypair) {
    return (
      <PostCreateUnlockRecovery
        embedded={embedded}
        title={t("bootstrap.createdTitle")}
        description={t("bootstrap.createdDescription")}
        passphraseLabel={t("bootstrap.passphraseLabel")}
        failedMessage={t("bootstrap.unlockFailed")}
        passphrase={passphrase}
        onPassphraseChange={setPassphrase}
        busy={busy}
        onSubmit={handleRetryUnlock}
      />
    );
  }

  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-md space-y-5 rounded-xl bg-card p-8 ring-1 ring-foreground/10"}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-pillar-knowledge/10">
          <LockClosedIcon className="size-6 text-pillar-knowledge" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{t("bootstrap.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("bootstrap.description")}</p>
      </div>

      <form onSubmit={handleBootstrap} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="bootstrap-pass">{t("bootstrap.passphraseLabel")}</FieldLabel>
          <Input
            id="bootstrap-pass"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <FieldDescription className={tooShort ? "text-destructive" : undefined}>
            {tooShort ? t("bootstrap.tooShort") : t("bootstrap.passphraseHint")}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="bootstrap-confirm">{t("bootstrap.confirmLabel")}</FieldLabel>
          <Input
            id="bootstrap-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
          {mismatch ? (
            <FieldDescription className="text-destructive">{t("bootstrap.mismatch")}</FieldDescription>
          ) : null}
        </Field>

        <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
          {t("bootstrap.warning")}
        </p>

        <Button
          type="submit"
          className="w-full"
          disabled={busy || !passphrase || passphrase !== confirm || passphrase.length < 8}
        >
          {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
          {busy ? t("bootstrap.creating") : t("bootstrap.submit")}
        </Button>
      </form>

      <RecoveryKeyModal
        open={recoveryKey != null}
        recoveryKey={recoveryKey ?? ""}
        onAcknowledge={handleAcknowledge}
      />
    </div>
  );
}

/**
 * PEER-RESET (ADR-0061 §6): a member who lost BOTH passphrase and recovery key sets a NEW passphrase →
 * `useResetKeypair` re-mints the keypair (new public key) → a new recovery key is shown once. CRUCIAL: a
 * reset gives them a fresh identity with NO vault access — a surviving vault member must re-grant each
 * vault to the new public key. We surface that loudly.
 */
function PeerResetFlow({ onCancel, embedded = false }: { onCancel: () => void; embedded?: boolean }) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { setPrivateKey } = useSecretSession();
  const resetKeypair = useResetKeypair();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [resetKeypairData, setResetKeypairData] = useState<UserKeypair | null>(null);
  // SECW-04: same discipline as bootstrap — a post-reset auto-unlock failure must not wipe back to blank,
  // because the IRREVERSIBLE reset already minted the new keypair.
  const [unlockFailed, setUnlockFailed] = useState(false);

  const mismatch = confirm.length > 0 && passphrase !== confirm;
  const tooShort = passphrase.length > 0 && passphrase.length < 8;

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !passphrase || passphrase !== confirm || passphrase.length < 8) return;
    setBusy(true);
    try {
      const { wire, recoveryKeyDisplay } = await bootstrapKeypair(passphrase);
      const updated = await resetKeypair.mutateAsync(wire);
      setResetKeypairData(updated);
      setRecoveryKey(recoveryKeyDisplay);
    } catch (err) {
      notifyError(err, t("reset.error"));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcknowledge() {
    const pass = passphrase;
    setRecoveryKey(null);
    if (!resetKeypairData) {
      setPassphrase("");
      setConfirm("");
      return;
    }
    try {
      const privateKey = await unlockWithPassphrase(resetKeypairData, pass);
      setPrivateKey(privateKey);
      // Success — only now drop the local secret state.
      setPassphrase("");
      setConfirm("");
      setResetKeypairData(null);
      setUnlockFailed(false);
    } catch {
      // Keep the freshly-minted keypair + passphrase; show the recovery view.
      setUnlockFailed(true);
    }
  }

  async function handleRetryUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !passphrase || !resetKeypairData) return;
    setBusy(true);
    try {
      const privateKey = await unlockWithPassphrase(resetKeypairData, passphrase);
      setPrivateKey(privateKey);
      setPassphrase("");
      setConfirm("");
      setResetKeypairData(null);
      setUnlockFailed(false);
    } catch {
      setUnlockFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (unlockFailed && resetKeypairData) {
    return (
      <PostCreateUnlockRecovery
        embedded={embedded}
        title={t("reset.createdTitle")}
        description={t("reset.createdDescription")}
        passphraseLabel={t("reset.passphraseLabel")}
        failedMessage={t("reset.unlockFailed")}
        passphrase={passphrase}
        onPassphraseChange={setPassphrase}
        busy={busy}
        onSubmit={handleRetryUnlock}
      />
    );
  }

  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-md space-y-5 rounded-xl bg-card p-8 ring-1 ring-foreground/10"}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
          <ExclamationTriangleIcon className="size-6 text-amber-600 dark:text-amber-400" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{t("reset.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("reset.description")}</p>
      </div>

      <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
        {t("reset.regrantWarning")}
      </p>

      <form onSubmit={handleReset} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="reset-pass">{t("reset.passphraseLabel")}</FieldLabel>
          <Input
            id="reset-pass"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
            autoFocus
          />
          {tooShort ? (
            <FieldDescription className="text-destructive">{t("bootstrap.tooShort")}</FieldDescription>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="reset-confirm">{t("reset.confirmLabel")}</FieldLabel>
          <Input
            id="reset-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
          {mismatch ? (
            <FieldDescription className="text-destructive">{t("bootstrap.mismatch")}</FieldDescription>
          ) : null}
        </Field>

        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>
            {tc("cancel")}
          </Button>
          <Button
            type="submit"
            className="flex-1"
            disabled={busy || !passphrase || passphrase !== confirm || passphrase.length < 8}
          >
            {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
            {busy ? t("reset.resetting") : t("reset.submit")}
          </Button>
        </div>
      </form>

      <RecoveryKeyModal
        open={recoveryKey != null}
        recoveryKey={recoveryKey ?? ""}
        onAcknowledge={handleAcknowledge}
      />
    </div>
  );
}

/**
 * POST-CREATE UNLOCK RECOVERY (SECW-04): rendered when an IRREVERSIBLE bootstrap/peer-reset succeeded
 * (keypair minted, recovery key saved) but the automatic post-acknowledge unlock threw. We MUST NOT drop
 * the user back to a blank create form — that would imply their keypair was lost. Instead we keep the
 * created keypair + the passphrase they typed and let them re-submit to unlock the existing identity.
 */
function PostCreateUnlockRecovery({
  embedded,
  title,
  description,
  passphraseLabel,
  failedMessage,
  passphrase,
  onPassphraseChange,
  busy,
  onSubmit,
}: {
  embedded: boolean;
  title: string;
  description: string;
  passphraseLabel: string;
  failedMessage: string;
  passphrase: string;
  onPassphraseChange: (value: string) => void;
  busy: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const t = useTranslations("secrets");
  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-md space-y-5 rounded-xl bg-card p-8 ring-1 ring-foreground/10"}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-pillar-knowledge/10">
          <LockClosedIcon className="size-6 text-pillar-knowledge" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="post-create-unlock">{passphraseLabel}</FieldLabel>
          <Input
            id="post-create-unlock"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => onPassphraseChange(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <FieldDescription className="text-destructive">{failedMessage}</FieldDescription>
        </Field>

        <Button type="submit" className="w-full" disabled={busy || !passphrase}>
          {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : <LockOpenIcon className="size-4" />}
          {busy ? t("unlock.unlocking") : t("unlock.submit")}
        </Button>
      </form>
    </div>
  );
}
