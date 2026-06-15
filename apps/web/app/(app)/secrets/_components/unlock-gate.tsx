"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  LockClosedIcon,
  LockOpenIcon,
} from "@heroicons/react/24/outline";
import type { CreateUserKeypair, UserKeypair } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";
import {
  useChangePassword,
  useCreateKeypair,
  useMyKeypair,
  useResetKeypair,
} from "@/lib/secret-manager/hooks/use-keypair";
import {
  bootstrapKeypair,
  rewrapPasswordCopy,
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
 * The LOCKED state (ADR-0066): a member who has a keypair enters their PASSWORD — the only direct ENTRY
 * credential — to unlock the private key into the in-memory session. The recovery key is NO LONGER a direct
 * unlock path: the "Forgot your password?" link goes to the RESET-PASSWORD flow (recovery key + a new
 * password → re-wrap Copy A → auto-unlock), and "I lost both" still starts a peer-reset.
 */
function UnlockFlow({ keypair, embedded = false }: { keypair: UserKeypair; embedded?: boolean }) {
  const t = useTranslations("secrets");
  const { setPrivateKey } = useSecretSession();
  // ADR-0066: only the password is a direct entry; "resetPassword" (recovery key → new password) and
  // "peerReset" (lost both) are recovery sub-flows. There is NO "recovery" direct-unlock mode anymore.
  const [mode, setMode] = useState<"password" | "resetPassword" | "peerReset">("password");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!secret || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // ENTRY is password-only now (ADR-0066) — the recovery key cannot unlock the session directly.
      const privateKey = await unlockWithPassphrase(keypair, secret);
      setSecret(""); // drop the entered secret from local state immediately
      setPrivateKey(privateKey);
    } catch {
      // The crypto layer throws a generic, payload-free decrypt error on a wrong password. Never surface
      // the raw error (it carries no secret, but keep the discipline) — just a friendly note.
      setFailed(true);
      setSecret("");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "resetPassword") {
    return <ResetPasswordFlow keypair={keypair} onCancel={() => setMode("password")} embedded={embedded} />;
  }

  if (mode === "peerReset") {
    return <PeerResetFlow onCancel={() => setMode("password")} embedded={embedded} />;
  }

  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-md space-y-5 rounded-xl bg-card p-8 ring-1 ring-foreground/10"}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-pillar-knowledge/10">
          <LockClosedIcon className="size-6 text-pillar-knowledge" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{t("unlock.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("unlock.description")}</p>
      </div>

      <form onSubmit={handleUnlock} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="unlock-secret">{t("unlock.passwordLabel")}</FieldLabel>
          <Input
            id="unlock-secret"
            type="password"
            autoComplete="current-password"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setFailed(false);
            }}
            disabled={busy}
            autoFocus
          />
          {failed ? (
            <FieldDescription className="text-destructive">
              {t("unlock.passwordFailed")}
            </FieldDescription>
          ) : null}
        </Field>

        <Button type="submit" className="w-full" disabled={busy || !secret}>
          {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : <LockOpenIcon className="size-4" />}
          {busy ? t("unlock.unlocking") : t("unlock.submit")}
        </Button>
      </form>

      {/* #452: this is an UNLOCK, not first-time setup — the keypair already exists. A recovery key is
          shown only ONCE at setup and is NOT re-displayed here. Stating that explicitly avoids the
          "I set my password but never saw a recovery key" confusion (the user reached unlock, not
          bootstrap). The "Forgot your password?" path below covers the lost-password case. */}
      <p className="rounded-md bg-muted/60 p-3 text-center text-xs text-muted-foreground">
        {t("unlock.alreadySetUpNote")}
      </p>

      <div className="flex flex-col items-center gap-1 border-t pt-4 text-center text-xs">
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => {
            setMode("resetPassword");
            setSecret("");
            setFailed(false);
          }}
        >
          {t("unlock.forgotPassword")}
        </button>
        <button
          type="button"
          className="text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setMode("peerReset")}
        >
          {t("unlock.lostBoth")}
        </button>
      </div>
    </div>
  );
}

/**
 * RESET PASSWORD with the recovery key (ADR-0066 §2c). The "I forgot my password but I have my recovery key"
 * path — it REPLACES the old "unlock directly with the recovery key" entry. The recovery key is the ROOT: it
 * can only RESET the password, never log in directly.
 *
 * Flow: unlock the private key with the RECOVERY KEY in the browser (wrong key → inline error, nothing
 * posted) → re-wrap Copy A under the NEW password (`rewrapPasswordCopy`) → POST `/keypair/password`
 * (overwrites ONLY Copy A; Copy B / public key / DEKs / memberships untouched) → AUTO-UNLOCK the session
 * with the private key we already hold (no second password prompt). The recovery key, the new password, and
 * the private key are EPHEMERAL: held only across this submit and dropped on success.
 *
 * AUTO-UNLOCK ORDERING: we set the private key into the session ONLY AFTER the POST succeeds. If the POST
 * fails the session stays locked and the user can retry; if it succeeds, the password they just set is live
 * and they land inside already unlocked with the key in memory.
 */
function ResetPasswordFlow({
  keypair,
  onCancel,
  embedded = false,
}: {
  keypair: UserKeypair;
  onCancel: () => void;
  embedded?: boolean;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { setPrivateKey } = useSecretSession();
  const changePassword = useChangePassword();
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  // Wrong RECOVERY KEY — inline error, nothing posted.
  const [failed, setFailed] = useState(false);
  const [noKeypair, setNoKeypair] = useState(false);

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const canSubmit =
    !busy &&
    Boolean(recoveryKey) &&
    Boolean(newPassword) &&
    newPassword === confirm &&
    newPassword.length >= 8;

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setFailed(false);
    setNoKeypair(false);

    // Step 1 — unlock the private key with the RECOVERY KEY in the browser. A wrong key throws the generic,
    // payload-free decrypt error BEFORE anything is posted; nothing changes.
    let privateKey: Uint8Array;
    try {
      privateKey = await unlockWithRecoveryKey(keypair, recoveryKey);
    } catch {
      setFailed(true);
      setRecoveryKey("");
      setBusy(false);
      return;
    }

    // Step 2 — re-wrap Copy A under the NEW password (browser).
    let wire;
    try {
      wire = await rewrapPasswordCopy(privateKey, newPassword);
    } catch (err) {
      notifyError(err, t("resetPassword.error"));
      setBusy(false);
      return;
    }

    // Step 3 — COMMIT the new Copy-A wrap server-side (overwrites ONLY the password copy). 404 means the
    // caller has no keypair (defensive — this surface only renders when one exists).
    try {
      await changePassword.mutateAsync(wire);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNoKeypair(true);
      } else {
        notifyError(err, t("resetPassword.error"));
      }
      setBusy(false);
      return;
    }

    // Step 4 — AUTO-UNLOCK: the new password is live and we already hold the private key the recovery key
    // unlocked, so set it into the session (no second prompt). Drop all secret state.
    setRecoveryKey("");
    setNewPassword("");
    setConfirm("");
    setPrivateKey(privateKey);
    setBusy(false);
  }

  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-md space-y-5 rounded-xl bg-card p-8 ring-1 ring-foreground/10"}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-pillar-knowledge/10">
          <KeyIcon className="size-6 text-pillar-knowledge" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{t("resetPassword.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("resetPassword.description")}</p>
      </div>

      <form onSubmit={handleReset} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="reset-password-recovery">{t("resetPassword.recoveryKeyLabel")}</FieldLabel>
          <Input
            id="reset-password-recovery"
            type="text"
            autoComplete="off"
            value={recoveryKey}
            onChange={(e) => {
              setRecoveryKey(e.target.value);
              setFailed(false);
              setNoKeypair(false);
            }}
            disabled={busy}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            autoFocus
          />
          {failed ? (
            <FieldDescription className="text-destructive">
              {t("resetPassword.recoveryFailed")}
            </FieldDescription>
          ) : null}
          {noKeypair ? (
            <FieldDescription className="text-destructive">
              {t("resetPassword.noKeypair")}
            </FieldDescription>
          ) : null}
        </Field>

        <Field>
          <FieldLabel htmlFor="reset-password-new">{t("resetPassword.newLabel")}</FieldLabel>
          <Input
            id="reset-password-new"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={busy}
          />
          <FieldDescription className={tooShort ? "text-destructive" : undefined}>
            {tooShort ? t("resetPassword.tooShort") : t("resetPassword.newHint")}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="reset-password-confirm">{t("resetPassword.confirmLabel")}</FieldLabel>
          <Input
            id="reset-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
          {mismatch ? (
            <FieldDescription className="text-destructive">
              {t("resetPassword.mismatch")}
            </FieldDescription>
          ) : null}
        </Field>

        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>
            {tc("cancel")}
          </Button>
          <Button type="submit" className="flex-1" disabled={!canSubmit}>
            {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : <LockOpenIcon className="size-4" />}
            {busy ? t("resetPassword.resetting") : t("resetPassword.submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * BOOTSTRAP: a brand-new user picks a vault passphrase, the browser mints a keypair (`bootstrapKeypair`),
 * the recovery key is shown ONCE, and ONLY AFTER the user explicitly acknowledges having saved it does the
 * wrapped material get POSTed to the server. On a successful POST we unlock the freshly created keypair
 * straight into the session (re-deriving from the passphrase the user just typed) so they land inside the
 * manager already unlocked.
 *
 * #452 HARDENING — recovery-key-before-persist invariant: the keypair material is generated and held in
 * browser memory FIRST, the `RecoveryKeyModal` is shown, and the POST happens INSIDE `handleAcknowledge`,
 * gated on the acknowledged modal. There is NO ordering where the server can hold a keypair before the
 * recovery key has been shown AND acknowledged — `bootstrapKeypair` (mint) no longer POSTs; the POST is
 * reachable only from the modal's acknowledge handler.
 */
function BootstrapFlow({ embedded = false }: { embedded?: boolean }) {
  const t = useTranslations("secrets");
  const { setPrivateKey } = useSecretSession();
  const createKeypair = useCreateKeypair();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  // The browser-minted wire DTO, held in memory while the recovery-key modal is up. It is POSTed ONLY
  // from `handleAcknowledge` — nothing is persisted server-side before the modal is acknowledged (#452).
  const [pendingWire, setPendingWire] = useState<CreateUserKeypair | null>(null);
  // The keypair returned by the (post-acknowledge) POST, used to unlock into the session.
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
      // Mint the keypair material in the browser ONLY — do NOT POST yet. The recovery key MUST be shown
      // and acknowledged before anything is persisted server-side (#452 recovery-key-before-persist).
      const { wire, recoveryKeyDisplay } = await bootstrapKeypair(passphrase);
      setPendingWire(wire);
      setRecoveryKey(recoveryKeyDisplay); // shown once via the modal; the POST is deferred to acknowledge
    } catch (err) {
      notifyError(err, t("bootstrap.error"));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcknowledge() {
    // The recovery key has been saved & acknowledged — ONLY NOW do we persist the keypair. We close the
    // modal, POST the held wire DTO, then unlock the new keypair into the session using the passphrase the
    // user just typed. ONLY drop local secret state once the unlock actually succeeds — an unlock failure
    // here would otherwise strand the user with an irreversible keypair they can't reach (SECW-04).
    const pass = passphrase;
    const wire = pendingWire;
    const shownRecoveryKey = recoveryKey; // captured before we close the modal, to re-show on POST failure
    setRecoveryKey(null);
    if (!wire) {
      setPassphrase("");
      setConfirm("");
      return;
    }
    setBusy(true);
    let created: UserKeypair;
    try {
      created = await createKeypair.mutateAsync(wire);
    } catch (err) {
      // The POST failed → the keypair was NOT persisted. Keep the held wire + passphrase so the user can
      // retry the POST WITHOUT re-minting (which would invalidate the already-shown recovery key). Re-show
      // the SAME recovery key behind the same acknowledge gate so the recovery-key-before-persist invariant
      // continues to hold on the retry.
      notifyError(err, t("bootstrap.error"));
      setRecoveryKey(shownRecoveryKey);
      setBusy(false);
      return;
    }
    setCreatedKeypair(created);
    setPendingWire(null); // persisted — drop the in-memory wire
    try {
      const privateKey = await unlockWithPassphrase(created, pass);
      setPrivateKey(privateKey);
      // Success — now it is safe to drop the local secret state.
      setPassphrase("");
      setConfirm("");
      setCreatedKeypair(null);
      setUnlockFailed(false);
    } catch {
      // POST succeeded but the auto-unlock threw — keep the created keypair + passphrase; show the
      // "created — unlock with your passphrase" recovery view (SECW-04).
      setUnlockFailed(true);
    } finally {
      setBusy(false);
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
 *
 * #452 HARDENING — same recovery-key-before-persist invariant as bootstrap: the new keypair material is
 * minted in the browser FIRST, the recovery key is shown, and the reset POST happens INSIDE
 * `handleAcknowledge`, gated on the acknowledged modal. The reset cannot replace the server-side keypair
 * before the new recovery key has been shown AND acknowledged.
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
  // The browser-minted wire DTO, held in memory while the recovery-key modal is up. POSTed (as a reset)
  // ONLY from `handleAcknowledge` — the server-side keypair is not replaced before acknowledge (#452).
  const [pendingWire, setPendingWire] = useState<CreateUserKeypair | null>(null);
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
      // Mint the new keypair material in the browser ONLY — do NOT POST the reset yet. The new recovery
      // key MUST be shown and acknowledged before the server-side keypair is replaced (#452).
      const { wire, recoveryKeyDisplay } = await bootstrapKeypair(passphrase);
      setPendingWire(wire);
      setRecoveryKey(recoveryKeyDisplay);
    } catch (err) {
      notifyError(err, t("reset.error"));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcknowledge() {
    // The recovery key has been saved & acknowledged — ONLY NOW do we POST the reset (replacing the
    // server-side keypair), then unlock the new keypair into the session.
    const pass = passphrase;
    const wire = pendingWire;
    const shownRecoveryKey = recoveryKey; // captured before we close the modal, to re-show on POST failure
    setRecoveryKey(null);
    if (!wire) {
      setPassphrase("");
      setConfirm("");
      return;
    }
    setBusy(true);
    let updated: UserKeypair;
    try {
      updated = await resetKeypair.mutateAsync(wire);
    } catch (err) {
      // The reset POST failed → the server-side keypair is unchanged. Keep the held wire + passphrase and
      // re-show the SAME recovery key behind the acknowledge gate so a retry still honours the invariant.
      notifyError(err, t("reset.error"));
      setRecoveryKey(shownRecoveryKey);
      setBusy(false);
      return;
    }
    setResetKeypairData(updated);
    setPendingWire(null); // reset persisted — drop the in-memory wire
    try {
      const privateKey = await unlockWithPassphrase(updated, pass);
      setPrivateKey(privateKey);
      // Success — only now drop the local secret state.
      setPassphrase("");
      setConfirm("");
      setResetKeypairData(null);
      setUnlockFailed(false);
    } catch {
      // Reset succeeded but the auto-unlock threw — keep the freshly-minted keypair + passphrase; show the
      // recovery view (SECW-04).
      setUnlockFailed(true);
    } finally {
      setBusy(false);
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
        <span className="flex size-12 items-center justify-center rounded-full bg-warning/10">
          <ExclamationTriangleIcon className="size-6 text-warning" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{t("reset.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("reset.description")}</p>
      </div>

      <Callout tone="warning" className="text-xs">
        {t("reset.regrantWarning")}
      </Callout>

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
