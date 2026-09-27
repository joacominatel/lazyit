"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import type {
  AdminPasswordResetDelivery,
  AdminPasswordResetOutcome,
  PasswordResetCapabilities,
  PasswordResetEmailUnavailableReason,
  User,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api/client";
import { useResetUserPassword } from "@/lib/api/hooks/use-user-mutations";
import { cn } from "@/lib/utils";
import { TemporaryPasswordReveal } from "./temporary-password-reveal";

/**
 * The LOCAL-mode admin password reset (`AUTH_MODE=local` — ADR-0086 §5, issue #1268). In local mode
 * lazyit owns the credential, so there is no IdP to hand the job to and the admin must say HOW the
 * reset reaches the person. The two deliveries mean genuinely different things, so this dialog makes
 * the choice explicit instead of guessing:
 *
 *   - **Email a reset link** — a single-use link through the INSTANCE SMTP; the subject picks their own
 *     password and lazyit never sees it. Offered only when the server says a link can actually be built
 *     AND sent (`canEmailResetLink`); otherwise it is disabled with the operator-actionable reason, so
 *     the admin is never invited into a request that is guaranteed to 409.
 *   - **Generate a temporary password** — the hand-off escape hatch for someone who cannot reach their
 *     mailbox. Always offered in local mode, deliberately including when email works.
 *
 * `revokeSessions` belongs to the EMAIL delivery only and defaults OFF: sending a link does not change
 * the stored credential, so the subject's live sessions are still legitimately theirs — killing them is
 * a deliberate "I think this is compromised" act. The temp-password delivery always revokes (it replaces
 * `passwordHash` on the spot), which the copy states rather than offering a checkbox that does nothing.
 *
 * Failure is never dressed up as success: a 409 (with its `reason`), 503 send failure, 422
 * inactive/directory-only, 501 managed-by-IdP and 404 all render INLINE and leave the dialog open, so
 * the admin can read what went wrong and pick the other delivery.
 */

/** Recognized 409 reasons, so an unknown/absent one degrades to generic copy instead of crashing. */
const EMAIL_UNAVAILABLE_REASONS: readonly PasswordResetEmailUnavailableReason[] =
  ["smtp-not-configured", "origin-unknown"];

/**
 * Pull the machine-readable `reason` out of a 409 body. The API's error payload carries it alongside the
 * human `message`; we read it defensively (unknown shape → `null`) and fall back to generic copy, since
 * a missing reason must never turn a real failure into an unexplained one.
 */
function emailUnavailableReasonOf(
  error: unknown,
): PasswordResetEmailUnavailableReason | null {
  if (!(error instanceof ApiError)) return null;
  const reason = (error.body as { reason?: unknown } | undefined)?.reason;
  return EMAIL_UNAVAILABLE_REASONS.includes(
    reason as PasswordResetEmailUnavailableReason,
  )
    ? (reason as PasswordResetEmailUnavailableReason)
    : null;
}

export function LocalPasswordResetDialog({
  user,
  capabilities,
  open,
  onOpenChange,
}: {
  user: User;
  /** Resolved server-side (`GET /users/password-reset-capabilities`); the caller only opens us in local mode. */
  capabilities: PasswordResetCapabilities;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("users.passwordReset.local");
  const tc = useTranslations("common");
  const resetPassword = useResetUserPassword();
  const revokeSessionsId = useId();

  const canEmail = capabilities.canEmailResetLink;
  const [delivery, setDelivery] = useState<AdminPasswordResetDelivery>(
    canEmail ? "email" : "temporary-password",
  );
  const [revokeSessions, setRevokeSessions] = useState(false);
  const [outcome, setOutcome] = useState<AdminPasswordResetOutcome | null>(null);
  // Inline, dialog-stays-open failure text. Cleared on every new attempt.
  const [error, setError] = useState<string | null>(null);

  const fullName = `${user.firstName} ${user.lastName}`;

  /** Reset every transient bit so re-opening the dialog never shows a stale reveal or error. */
  function handleOpenChange(next: boolean) {
    if (!next) {
      setOutcome(null);
      setError(null);
      setRevokeSessions(false);
      setDelivery(canEmail ? "email" : "temporary-password");
    }
    onOpenChange(next);
  }

  function submit() {
    setError(null);
    resetPassword.mutate(
      {
        id: user.id,
        body: {
          delivery,
          // Only meaningful for the email delivery; the API ignores it on the other path, but we keep
          // the request honest about what the admin actually chose.
          ...(delivery === "email" ? { revokeSessions } : {}),
        },
      },
      {
        onSuccess: (result) => {
          // The union's `void` arm is the OIDC 204 — unreachable here, but typed, so guard rather than cast.
          if (result) setOutcome(result);
          else handleOpenChange(false);
        },
        onError: (err) => setError(messageForError(err)),
      },
    );
  }

  /** Map the honest non-success statuses to real copy; anything else keeps the server's own message. */
  function messageForError(err: unknown): string {
    if (!(err instanceof ApiError)) return t("errors.generic");
    switch (err.status) {
      case 409: {
        const reason = emailUnavailableReasonOf(err);
        return reason
          ? t(`errors.emailUnavailable.${reason}`)
          : err.message || t("errors.emailUnavailable.generic");
      }
      case 503:
        return t("errors.sendFailed");
      case 422:
        return t("errors.inactive");
      case 501:
        return t("errors.managed");
      case 404:
        return t("errors.notFound");
      default:
        return err.message || t("errors.generic");
    }
  }

  const options: {
    value: AdminPasswordResetDelivery;
    icon: typeof EnvelopeIcon;
    title: string;
    description: string;
    disabled: boolean;
  }[] = [
    {
      value: "email",
      icon: EnvelopeIcon,
      title: t("email.title"),
      description: t("email.description", { email: user.email }),
      disabled: !canEmail,
    },
    {
      // Always offered in local mode, deliberately including when email works: it is the way out for
      // someone who cannot reach their mailbox.
      value: "temporary-password",
      icon: KeyIcon,
      title: t("temporary.title"),
      description: t("temporary.description"),
      disabled: false,
    },
  ];

  // While the one-time password is on screen — or while the request is in flight — an accidental Esc /
  // backdrop click would destroy a credential that can never be retrieved. Lock the dialog shut in both
  // states (and hide the X): the only way out of the reveal is the explicit acknowledgement.
  const locked = outcome?.delivery === "temporary-password" || resetPassword.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!locked}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        {outcome?.delivery === "temporary-password" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("success.temporaryTitle")}</DialogTitle>
            </DialogHeader>
            <TemporaryPasswordReveal
              password={outcome.temporaryPassword}
              message={t.rich("success.temporaryMessage", {
                name: fullName,
                b: (chunks) => (
                  <span className="font-medium text-foreground">{chunks}</span>
                ),
              })}
              onDone={() => handleOpenChange(false)}
            />
          </>
        ) : outcome?.delivery === "email" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("success.emailTitle")}</DialogTitle>
            </DialogHeader>
            <Callout
              tone="success"
              icon={<CheckCircleIcon />}
              className="rounded-lg text-sm"
            >
              <div className="space-y-1">
                <p>
                  {t.rich("success.emailBody", {
                    email: outcome.sentTo,
                    minutes: outcome.expiresInMinutes,
                    strong: (chunks) => (
                      <span className="font-medium">{chunks}</span>
                    ),
                  })}
                </p>
                <p className="text-muted-foreground">
                  {outcome.sessionsRevoked
                    ? t("success.emailSessionsRevoked")
                    : t("success.emailSessionsKept")}
                </p>
              </div>
            </Callout>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>
                {tc("close")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("title", { name: fullName })}</DialogTitle>
              <DialogDescription>{t("intro")}</DialogDescription>
            </DialogHeader>

            <div
              role="radiogroup"
              aria-label={t("deliveryLabel")}
              className="grid gap-3"
            >
              {options.map((option) => {
                const selected = delivery === option.value;
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={option.disabled || resetPassword.isPending}
                    onClick={() => setDelivery(option.value)}
                    className={cn(
                      "flex w-full gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40 hover:bg-muted/50",
                      option.disabled &&
                        "cursor-not-allowed opacity-60 hover:border-border hover:bg-transparent",
                    )}
                  >
                    <Icon
                      className="mt-0.5 size-5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">
                        {option.title}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Why the email option is greyed out. It sits OUTSIDE the disabled control (and outside the
                radiogroup) so it stays readable and reachable rather than hiding in a `title`. */}
            {!canEmail && (
              <Callout
                tone="warning"
                icon={<ExclamationTriangleIcon />}
                className="rounded-lg text-xs"
              >
                {t(
                  `email.unavailable.${capabilities.emailUnavailableReason ?? "generic"}`,
                )}
              </Callout>
            )}

            {/* Session revocation is an EMAIL-only choice — the temp-password path always revokes, so
                it gets a plain statement instead of a checkbox that does nothing. */}
            {delivery === "email" ? (
              <div className="flex items-start gap-2 rounded-lg border p-3">
                <Checkbox
                  id={revokeSessionsId}
                  checked={revokeSessions}
                  onCheckedChange={(checked) =>
                    setRevokeSessions(checked === true)
                  }
                  disabled={resetPassword.isPending}
                  className="mt-0.5"
                />
                <label htmlFor={revokeSessionsId} className="space-y-1 text-sm">
                  <span className="block">{t("email.revokeSessions")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("email.revokeSessionsHint")}
                  </span>
                </label>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("temporary.revokesAlways")}
              </p>
            )}

            {error && (
              <Callout
                tone="warning"
                icon={<ExclamationTriangleIcon />}
                className="rounded-lg text-sm"
                role="alert"
              >
                {error}
              </Callout>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={resetPassword.isPending}
              >
                {tc("cancel")}
              </Button>
              <Button onClick={submit} disabled={resetPassword.isPending}>
                {resetPassword.isPending && (
                  <ArrowPathIcon className="animate-spin" aria-hidden="true" />
                )}
                {delivery === "email"
                  ? t("email.submit")
                  : t("temporary.submit")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
