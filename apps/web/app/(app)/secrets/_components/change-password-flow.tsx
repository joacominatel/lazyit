"use client";

import { ArrowPathIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { UserKeypair } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useReducer, useState } from "react";
import { toast } from "sonner";
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
import {
  rewrapPasswordCopy,
  unlockWithPassphrase,
} from "@/lib/secret-manager/crypto";
import { useChangePassword } from "@/lib/secret-manager/hooks/use-keypair";

type ChangePasswordState = {
  currentPassword: string;
  newPassword: string;
  confirm: string;
  busy: boolean;
  /** Wrong CURRENT password — inline error, nothing posted. */
  failed: boolean;
  /** 404: the caller has no keypair (cannot happen from this surface, but handled defensively). */
  noKeypair: boolean;
};

type ChangePasswordAction =
  | { type: "currentChanged"; value: string }
  | { type: "newChanged"; value: string }
  | { type: "confirmChanged"; value: string }
  | { type: "submitStart" }
  | { type: "currentFailed" }
  | { type: "submitError" }
  | { type: "noKeypair" }
  | { type: "reset" };

const changePasswordInitialState: ChangePasswordState = {
  currentPassword: "",
  newPassword: "",
  confirm: "",
  busy: false,
  failed: false,
  noKeypair: false,
};

function changePasswordReducer(
  state: ChangePasswordState,
  action: ChangePasswordAction,
): ChangePasswordState {
  switch (action.type) {
    case "currentChanged":
      return { ...state, currentPassword: action.value, failed: false, noKeypair: false };
    case "newChanged":
      return { ...state, newPassword: action.value };
    case "confirmChanged":
      return { ...state, confirm: action.value };
    case "submitStart":
      return { ...state, busy: true, failed: false, noKeypair: false };
    case "currentFailed":
      return { ...state, failed: true, currentPassword: "", busy: false };
    case "submitError":
      return { ...state, busy: false };
    case "noKeypair":
      return { ...state, noKeypair: true, busy: false };
    case "reset":
      return changePasswordInitialState;
  }
}

/**
 * ChangePasswordFlow — change the daily ENTRY password (Copy A) of an EXISTING keypair (ADR-0066, #452).
 *
 * The "I know my current password and want a new one" path, surfaced in the unlocked `/secrets` header. It
 * re-wraps ONLY Copy A (`POST /secret-manager/keypair/password`): the public key, the per-vault DEKs, every
 * membership, AND the recovery key (Copy B) are untouched — no DEK re-wrap, no membership churn, the recovery
 * key keeps working. The session stays unlocked throughout (the private key in the session never changes —
 * only the at-rest wrapping does).
 *
 * ALWAYS REQUIRE THE CURRENT PASSWORD (ADR-0066): the flow re-derives the private key from the CURRENT
 * password typed here EVERY time — it NEVER reuses the already-in-memory session key. This both verifies the
 * current password (a wrong one fails the unlock → inline error, nothing is posted) and is the security
 * boundary against a walk-up attacker changing the password on an unattended unlocked session. The unwrapped
 * private key lives only between `unlockWithPassphrase` and `rewrapPasswordCopy` and is dropped after — it
 * never enters or replaces the in-memory session.
 *
 * INV-10 / ephemeral discipline: the current and new passwords are held in local state ONLY while the dialog
 * is open and dropped after submit; the re-wrap happens in the browser; the server stores ONLY the new
 * wrapped Copy-A blob; nothing secret is cached, logged, or sent.
 */
export function ChangePasswordFlow({
  keypair,
}: {
  /** The caller's existing keypair (from `GET /keypair/me`). The flow renders only when this exists. */
  keypair: UserKeypair;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const changePassword = useChangePassword();
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(changePasswordReducer, changePasswordInitialState);
  const { currentPassword, newPassword, confirm, busy, failed, noKeypair } = state;

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const canSubmit =
    !busy &&
    Boolean(currentPassword) &&
    Boolean(newPassword) &&
    newPassword === confirm &&
    newPassword.length >= 8;

  function reset() {
    dispatch({ type: "reset" });
  }

  function handleOpenChange(next: boolean) {
    // While the re-wrap/POST is in flight the dialog must not be dismissible — a stray close would
    // interrupt an in-flight write.
    if (busy) return;
    setOpen(next);
    if (!next) reset();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    dispatch({ type: "submitStart" });

    // Step 1 — unlock the private key with the CURRENT password IN THE BROWSER (this verifies it). A wrong
    // password throws the generic, payload-free decrypt error BEFORE anything is posted; nothing changes.
    let privateKey: Uint8Array;
    try {
      privateKey = await unlockWithPassphrase(keypair, currentPassword);
    } catch {
      dispatch({ type: "currentFailed" });
      return;
    }

    // Step 2 — re-wrap Copy A under the NEW password (browser). The private key is dropped after this.
    let wire;
    try {
      wire = await rewrapPasswordCopy(privateKey, newPassword);
    } catch (err) {
      notifyError(err, t("changePassword.error"));
      dispatch({ type: "submitError" });
      return;
    }

    // Step 3 — COMMIT the new Copy-A wrap server-side. Copy B / public key are untouched; the session stays
    // unlocked (we never touched the in-memory key).
    try {
      await changePassword.mutateAsync(wire);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        dispatch({ type: "noKeypair" });
      } else {
        notifyError(err, t("changePassword.error"));
        dispatch({ type: "submitError" });
      }
      return;
    }

    // Success — drop all secret state, close the dialog, toast.
    reset();
    setOpen(false);
    toast.success(t("changePassword.success"));
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title={t("changePassword.triggerHint")}
      >
        <KeyIcon className="size-4" aria-hidden />
        {t("changePassword.trigger")}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyIcon className="size-5 text-pillar-knowledge" aria-hidden />
              {t("changePassword.title")}
            </DialogTitle>
            <DialogDescription>
              {t("changePassword.description")}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="change-current-pass">
                {t("changePassword.currentLabel")}
              </FieldLabel>
              <Input
                id="change-current-pass"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) =>
                  dispatch({ type: "currentChanged", value: e.target.value })
                }
                disabled={busy}
                autoFocus
              />
              {failed ? (
                <FieldDescription className="text-destructive">
                  {t("changePassword.currentFailed")}
                </FieldDescription>
              ) : null}
              {noKeypair ? (
                <FieldDescription className="text-destructive">
                  {t("changePassword.noKeypair")}
                </FieldDescription>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="change-new-pass">
                {t("changePassword.newLabel")}
              </FieldLabel>
              <Input
                id="change-new-pass"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) =>
                  dispatch({ type: "newChanged", value: e.target.value })
                }
                disabled={busy}
              />
              <FieldDescription className={tooShort ? "text-destructive" : undefined}>
                {tooShort
                  ? t("changePassword.tooShort")
                  : t("changePassword.newHint")}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="change-confirm-pass">
                {t("changePassword.confirmLabel")}
              </FieldLabel>
              <Input
                id="change-confirm-pass"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) =>
                  dispatch({ type: "confirmChanged", value: e.target.value })
                }
                disabled={busy}
              />
              {mismatch ? (
                <FieldDescription className="text-destructive">
                  {t("changePassword.mismatch")}
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
              <Button type="submit" disabled={!canSubmit}>
                {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
                {busy
                  ? t("changePassword.changing")
                  : t("changePassword.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
