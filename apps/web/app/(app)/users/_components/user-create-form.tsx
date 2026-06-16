"use client";

import {
  ArrowPathIcon,
  CheckIcon,
  EyeIcon,
  EyeSlashIcon,
  SparklesIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type CreateUser,
  CreateUserSchema,
  type ManagerFormValue,
  type Role,
  RoleSchema,
  toManagerInput,
} from "@lazyit/shared";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, type Resolver, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ApplicationCombobox } from "@/components/application-combobox";
import { AssetCombobox } from "@/components/asset-combobox";
import { AccessLevelCombobox } from "@/components/access-level-combobox";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";
import { useGrantAccess } from "@/lib/api/hooks/use-access-grant-mutations";
import { useAssignUser } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { useCreateUser } from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";
import { ManagerField } from "./manager-field";

const FORM_ID = "user-create-form";

/** Role values shown in the create Select (the shared enum's order; labels resolved via i18n). */
const ROLE_VALUES: readonly Role[] = RoleSchema.options;

/** A blank manager picker (no manager recorded). */
const EMPTY_MANAGER: ManagerFormValue = { kind: "none" };

/**
 * The full-page create form's internal value shape. Identity mirrors the dialog's loose shape
 * (`legajo`/`username` empty-string-safe; `manager` the XOR discriminator). `password` is the
 * temporary credential — present in the form only on the management path. `assetId` / `applicationId`
 * / `accessLevel` are the optional assign-at-creation selections.
 */
type UserCreateFormValues = {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  legajo: string;
  username: string;
  manager: ManagerFormValue;
  password: string;
  assetId: string;
  applicationId: string;
  accessLevel: string;
};

const EMPTY_VALUES: UserCreateFormValues = {
  email: "",
  firstName: "",
  lastName: "",
  role: "VIEWER",
  legajo: "",
  username: "",
  manager: EMPTY_MANAGER,
  password: "",
  assetId: "",
  applicationId: "",
  accessLevel: "",
};

/**
 * Translate the form's loose values into the wire payload the resolver validates. Empty optionals are
 * dropped (not `""`, which fails `min(1)`); `manager` is serialized via `toManagerInput`. The
 * temporary `password` is included ONLY when management is supported and a value was typed — never
 * sent under BYOI (ADR-0064 §4). The assign-at-creation fields are stripped: they are not part of
 * `CreateUserSchema` (a `strictObject`) and fan out to their own endpoints after the user is created.
 */
function toResolverInput(
  values: UserCreateFormValues,
  requiresPassword: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    email: values.email,
    firstName: values.firstName,
    lastName: values.lastName,
    role: values.role,
    manager: toManagerInput(values.manager),
  };
  // Coalesce before `.trim()` — an untouched optional can be `undefined` at submit (RHF), even
  // though the field is typed `string` with an `""` default.
  if ((values.legajo ?? "").trim() !== "") out.legajo = values.legajo;
  if ((values.username ?? "").trim() !== "") out.username = values.username;
  if (requiresPassword && values.password !== "") out.password = values.password;
  return out;
}

/**
 * Generate a strong temporary password that satisfies {@link TempPasswordSchema} (≥8, ≤70, with an
 * uppercase, lowercase, digit and symbol). Uses the Web Crypto RNG; guarantees one of each required
 * class then fills to 16 chars and shuffles, so the result always validates.
 */
function generateTempPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const all = upper + lower + digits + symbols;
  const pick = (set: string) =>
    set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];

  const required = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const rest = Array.from({ length: 12 }, () => pick(all));
  const chars = [...required, ...rest];
  // Fisher–Yates shuffle so the guaranteed classes aren't always in the first four positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Live complexity checklist mirroring the rules of {@link TempPasswordSchema}. */
function PasswordChecklist({ password }: { password: string }) {
  const t = useTranslations("users.create.credential.checklist");
  const items: { label: string; passed: boolean }[] = [
    { label: t("length"), passed: password.length >= 8 && password.length <= 70 },
    { label: t("uppercase"), passed: /[A-Z]/.test(password) },
    { label: t("lowercase"), passed: /[a-z]/.test(password) },
    { label: t("number"), passed: /[0-9]/.test(password) },
    { label: t("symbol"), passed: /[^A-Za-z0-9]/.test(password) },
  ];
  return (
    <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item.label}
          className={cn(
            "flex items-center gap-2 text-xs",
            item.passed ? "text-success" : "text-muted-foreground",
          )}
        >
          {item.passed ? (
            <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <XMarkIcon
              className="size-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
          )}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Full-page, asset-style user-creation flow (ADR-0064, issue #411). The admin configures identity,
 * RBAC role and — on the bundled-Zitadel management path only — a one-time temporary password, and
 * optionally assigns one asset and/or grants one application access, all in a single comfortable page.
 *
 * The credential section is gated by `requiresAdminPassword` from `GET /config/status` (the same flag
 * the first-run wizard reads): present only when the bundled IdP manages credentials, hidden entirely
 * under BYOI so no password UI shows and no password is ever sent. Client validation reuses the shared
 * `CreateUserSchema` (which already carries the optional `password` validated by `TempPasswordSchema`)
 * so the form never duplicates a rule the server owns.
 *
 * Submit orchestration is best-effort (ADR-0064 §1): create the user FIRST, then fan out the optional
 * asset assignment and app grant. A failed assignment/grant never un-creates the user — it toasts a
 * non-blocking warning. On the management path the just-set temporary password is shown ONCE in a
 * hand-off confirmation before navigating to the new user's detail page.
 */
export function UserCreateForm() {
  const t = useTranslations("users.create");
  const tForm = useTranslations("users.form");
  const tRole = useTranslations("users.role");
  const tc = useTranslations("common");
  const router = useRouter();

  // Capability flag — `requiresAdminPassword` is the bundled-Zitadel management signal (BYOI → false).
  // Same hook the first-run wizard uses; while it loads we hold the credential section back.
  const { data: status, isLoading: statusLoading } = useConfigStatus();
  const requiresPassword = status?.requiresAdminPassword ?? false;

  const createUser = useCreateUser();
  const assignUser = useAssignUser();
  const grantAccess = useGrantAccess();
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // The shown-once hand-off: the created user's id + the temp password we set on the IdP.
  const [handoff, setHandoff] = useState<{
    userId: string;
    name: string;
    password: string;
  } | null>(null);

  // One resolver wraps the shared `CreateUserSchema` so it validates the wire shape (manager
  // serialized, empties dropped, password included only on the management path). The form shape and
  // the wire shape genuinely differ on `manager`, so the wrapped resolver is cast through `unknown` —
  // the runtime contract (the shared schema) is what matters.
  const baseResolver = zodResolver(CreateUserSchema);
  const resolver: Resolver<UserCreateFormValues> = (values, context, options) =>
    (
      baseResolver as unknown as (
        v: unknown,
        c: unknown,
        o: unknown,
      ) => ReturnType<Resolver<UserCreateFormValues>>
    )(toResolverInput(values, requiresPassword), context, options);

  const form = useForm<UserCreateFormValues>({
    resolver,
    defaultValues: EMPTY_VALUES,
  });

  const passwordValue =
    useWatch({ control: form.control, name: "password" }) ?? "";

  const onSubmit = form.handleSubmit(async (values) => {
    // On the management path the temporary password is REQUIRED (no SMTP on the bundled IdP — without
    // it the new user can't log in, ADR-0064 §2/§3). The shared `CreateUserSchema` keeps `password`
    // optional (correct for BYOI, where it's never sent), so the page enforces requiredness here.
    if (requiresPassword && values.password === "") {
      form.setError("password", {
        type: "required",
        message: t("credential.passwordRequired"),
      });
      // This manual error is set outside RHF's resolver, so `onInvalid` below won't fire — scroll to
      // it here (the password input's `aria-invalid` repaints first; the helper defers a frame).
      scrollToFirstError(document.getElementById(FORM_ID));
      return;
    }

    setSubmitting(true);

    // Coalesce before `.trim()` — RHF can hand back `undefined` for an untouched optional even
    // though the field is typed `string`/`""` (same guard as `accessLevel` below).
    const legajo = (values.legajo ?? "").trim();
    const username = (values.username ?? "").trim();
    const manager = toManagerInput(values.manager);

    const payload: CreateUser = {
      email: values.email,
      firstName: values.firstName,
      lastName: values.lastName,
      role: values.role,
      // Omit the unique optionals when blank so the create can't collide on an empty value.
      ...(legajo !== "" ? { legajo } : {}),
      ...(username !== "" ? { username } : {}),
      manager,
      // Send the temporary password ONLY on the management path (never under BYOI — ADR-0064 §4).
      ...(requiresPassword && values.password !== ""
        ? { password: values.password }
        : {}),
    };

    let created: Awaited<ReturnType<typeof createUser.mutateAsync>>;
    try {
      created = await createUser.mutateAsync(payload);
    } catch (error) {
      notifyError(error, t("toast.createError"));
      setSubmitting(false);
      return;
    }

    const name = `${created.firstName} ${created.lastName}`;
    toast.success(t("toast.created", { name }));

    // Best-effort fan-out: a failed assignment/grant NEVER un-creates the user (ADR-0064 §1) — it
    // surfaces as a non-blocking warning toast. Both run before navigating.
    if (values.assetId !== "") {
      try {
        await assignUser.mutateAsync({
          assetId: values.assetId,
          userId: created.id,
        });
        toast.success(t("toast.assetAssigned"));
      } catch (error) {
        notifyError(error, t("toast.assetError"));
      }
    }
    if (values.applicationId !== "") {
      // RHF can yield `undefined` for an untouched optional field even though it is typed `string`
      // with an `""` default, so coalesce before calling a string method (the field was reset, or
      // never registered, on some paths). Downstream only assigns when non-empty.
      const level = (values.accessLevel ?? "").trim();
      try {
        await grantAccess.mutateAsync({
          userId: created.id,
          applicationId: values.applicationId,
          ...(level !== "" ? { accessLevel: level } : {}),
        });
        toast.success(t("toast.accessGranted"));
      } catch (error) {
        notifyError(error, t("toast.accessError"));
      }
    }

    // On the management path, show the temporary password ONCE for hand-off before navigating. Under
    // BYOI there is no password to show, so go straight to the new user's detail page.
    if (requiresPassword && values.password !== "") {
      setHandoff({ userId: created.id, name, password: values.password });
      setSubmitting(false);
      return;
    }

    router.push(`/users/${created.id}`);
  }, (_errors, event) => scrollToFirstError(event?.target ?? null));

  // ── Shown-once temporary-password hand-off ────────────────────────────────────────────────────
  if (handoff) {
    return (
      <div className="space-y-6">
        <FieldSet className="rounded-xl border border-primary/30 bg-primary/5 p-5">
          <FieldLegend>{t("handoff.title")}</FieldLegend>
          <FieldDescription>
            {t("handoff.description", { name: handoff.name })}
          </FieldDescription>
          <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 font-mono text-sm">
            <span className="flex-1 break-all">{handoff.password}</span>
            <CopyButton
              value={handoff.password}
              label={t("handoff.copyLabel")}
              toastMessage={t("handoff.copied")}
            />
          </div>
          <FieldDescription className="text-warning">
            {t("handoff.warning")}
          </FieldDescription>
        </FieldSet>
        <div className="flex justify-end">
          <Button onClick={() => router.push(`/users/${handoff.userId}`)}>
            {t("handoff.openUser")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-8">
      {/* ── Identity ─────────────────────────────────────────────────────────────────────────── */}
      <FieldSet>
        <FieldLegend>{t("sections.identity")}</FieldLegend>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="firstName"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="firstName" required>
                    {tForm("firstName")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="firstName"
                    value={field.value ?? ""}
                    placeholder="Ada"
                    aria-invalid={fieldState.invalid || undefined}
                    autoFocus
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="lastName"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="lastName" required>
                    {tForm("lastName")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="lastName"
                    value={field.value ?? ""}
                    placeholder="Lovelace"
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </div>

          <Controller
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="email" required>
                  {tForm("email")}
                </FieldLabel>
                <Input
                  {...field}
                  id="email"
                  type="email"
                  value={field.value ?? ""}
                  placeholder="ada@lazyit.dev"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="role"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="role">{t("role.label")}</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="role" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLE_VALUES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {tRole(`labels.${value}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {tRole(`hints.${field.value}`)}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="legajo"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="legajo">{tForm("legajo")}</FieldLabel>
                  <Input
                    {...field}
                    id="legajo"
                    value={field.value ?? ""}
                    placeholder={tForm("legajoPlaceholder")}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldDescription>{tForm("legajoHelp")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="username"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="username">{tForm("username")}</FieldLabel>
                  <Input
                    {...field}
                    id="username"
                    value={field.value ?? ""}
                    placeholder={tForm("usernamePlaceholder")}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldDescription>{tForm("usernameHelp")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="manager"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="manager">
                    {tForm("manager.label")}
                  </FieldLabel>
                  <ManagerField
                    id="manager"
                    value={field.value}
                    onChange={field.onChange}
                    ariaInvalid={fieldState.invalid}
                  />
                  <FieldDescription>{tForm("manager.help")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </div>
        </FieldGroup>
      </FieldSet>

      {/* ── Credential provisioning (management path only — hidden under BYOI, ADR-0064 §4) ────── */}
      {!statusLoading && requiresPassword ? (
        <>
          <FieldSeparator />
          <FieldSet>
            <FieldLegend>{t("credential.title")}</FieldLegend>
            <FieldDescription>{t("credential.description")}</FieldDescription>
            <FieldGroup>
              <Controller
                control={form.control}
                name="password"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="password" required>
                      {t("credential.passwordLabel")}
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <Input
                        {...field}
                        id="password"
                        type={showPassword ? "text" : "password"}
                        value={field.value ?? ""}
                        autoComplete="new-password"
                        placeholder="••••••••"
                        className="font-mono"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={
                          showPassword
                            ? t("credential.hide")
                            : t("credential.show")
                        }
                        title={
                          showPassword
                            ? t("credential.hide")
                            : t("credential.show")
                        }
                        onClick={() => setShowPassword((v) => !v)}
                      >
                        {showPassword ? (
                          <EyeSlashIcon className="size-4" />
                        ) : (
                          <EyeIcon className="size-4" />
                        )}
                      </Button>
                      {passwordValue ? (
                        <CopyButton
                          value={passwordValue}
                          label={t("credential.copyLabel")}
                        />
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          form.setValue("password", generateTempPassword(), {
                            shouldValidate: true,
                            shouldDirty: true,
                          });
                          setShowPassword(true);
                        }}
                      >
                        <SparklesIcon className="size-4" />
                        {t("credential.generate")}
                      </Button>
                    </div>
                    <PasswordChecklist password={passwordValue} />
                    <FieldDescription>
                      {t("credential.passwordHelp")}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            </FieldGroup>
          </FieldSet>
        </>
      ) : null}

      {/* ── Assignments (optional head start) ─────────────────────────────────────────────────── */}
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>{t("assignments.title")}</FieldLegend>
        <FieldDescription>{t("assignments.description")}</FieldDescription>
        <FieldGroup>
          <Controller
            control={form.control}
            name="assetId"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="assetId">
                  {t("assignments.assetLabel")}
                </FieldLabel>
                <AssetCombobox
                  id="assetId"
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                  placeholder={t("assignments.assetPlaceholder")}
                  searchPlaceholder={t("assignments.assetSearch")}
                  emptyText={t("assignments.assetEmpty")}
                />
                <FieldDescription>
                  {t("assignments.assetHelp")}
                </FieldDescription>
              </Field>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="applicationId"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="applicationId">
                    {t("assignments.applicationLabel")}
                  </FieldLabel>
                  <ApplicationCombobox
                    id="applicationId"
                    value={field.value || undefined}
                    onValueChange={field.onChange}
                    placeholder={t("assignments.applicationPlaceholder")}
                    searchPlaceholder={t("assignments.applicationSearch")}
                    emptyText={t("assignments.applicationEmpty")}
                  />
                  <FieldDescription>
                    {t("assignments.applicationHelp")}
                  </FieldDescription>
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="accessLevel"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="accessLevel">
                    {t("assignments.accessLevelLabel")}
                  </FieldLabel>
                  <AccessLevelCombobox
                    id="accessLevel"
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                  <FieldDescription>
                    {t("assignments.accessLevelHelp")}
                  </FieldDescription>
                </Field>
              )}
            />
          </div>
        </FieldGroup>
      </FieldSet>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => router.push("/users")}
        >
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={submitting}>
          {submitting && <ArrowPathIcon className="animate-spin" />}
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
