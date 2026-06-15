"use client"

import { createContext, useContext, useId, useMemo } from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

/**
 * Shared per-`Field` accessibility context. Each `Field` mints one stable error-node id (`useId`)
 * so the control and its `FieldError` can be programmatically linked (WCAG 1.3.1 / 3.3.1): the error
 * text renders with this `id`, and the invalid control points at it via `aria-describedby` /
 * `aria-errormessage`. Threaded through context so existing call sites inherit the wiring with no
 * per-form edits — the only signal a `Field` needs from the call site is its already-present
 * `data-invalid` prop.
 */
type FieldContextValue = { errorId: string; invalid: boolean }

const FieldContext = createContext<FieldContextValue | null>(null)

/**
 * Merge a `Field`'s error id into a control's `aria-describedby` (and set `aria-errormessage`) only
 * while the field is invalid, so a screen-reader user landing on the control hears *why* it failed —
 * not just that it's "invalid" (WCAG 1.3.1 / 3.3.1). Outside a `Field`, or while valid, the
 * caller's own `aria-describedby` / `aria-errormessage` pass through untouched.
 *
 * Native controls (`Input`, `Textarea`, the Radix `SelectTrigger`) call this with their incoming
 * aria props and spread the result onto the rendered element — so the linkage holds even though
 * those controls are function components that React does not let the parent `Field` clone into.
 */
function useFieldErrorLink({
  "aria-describedby": describedBy,
  "aria-errormessage": errorMessage,
}: {
  "aria-describedby"?: string
  "aria-errormessage"?: string
} = {}): { "aria-describedby"?: string; "aria-errormessage"?: string } {
  const ctx = useContext(FieldContext)
  if (!ctx?.invalid) {
    return { "aria-describedby": describedBy, "aria-errormessage": errorMessage }
  }
  return {
    "aria-describedby": [describedBy, ctx.errorId].filter(Boolean).join(" "),
    "aria-errormessage": errorMessage ?? ctx.errorId,
  }
}

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "flex flex-col gap-4 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3",
        className
      )}
      {...props}
    />
  )
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: React.ComponentProps<"legend"> & { variant?: "legend" | "label" }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "mb-1.5 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base",
        className
      )}
      {...props}
    />
  )
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4",
        className
      )}
      {...props}
    />
  )
}

const fieldVariants = cva(
  "group/field flex w-full gap-2 data-[invalid=true]:text-destructive",
  {
    variants: {
      orientation: {
        vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
        horizontal:
          "flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        responsive:
          "flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  }
)

function Field({
  className,
  orientation = "vertical",
  children,
  "data-invalid": dataInvalid,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof fieldVariants> & {
    /** Set from the RHF `fieldState.invalid` at the call site; drives the error-link wiring. */
    "data-invalid"?: boolean | "true" | "false"
  }) {
  const errorId = useId()
  // Every converged field passes `data-invalid` from its RHF `fieldState.invalid`, so this mirrors
  // the control's `aria-invalid` without the call site wiring anything new. Native controls read
  // this via `useFieldErrorLink` and link themselves to `FieldError` when invalid.
  const invalid = dataInvalid === true || dataInvalid === "true"
  const context = useMemo<FieldContextValue>(
    () => ({ errorId, invalid }),
    [errorId, invalid],
  )
  return (
    <FieldContext.Provider value={context}>
      <div
        role="group"
        data-slot="field"
        data-orientation={orientation}
        data-invalid={dataInvalid}
        className={cn(fieldVariants({ orientation }), className)}
        {...props}
      >
        {children}
      </div>
    </FieldContext.Provider>
  )
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "group/field-content flex flex-1 flex-col gap-0.5 leading-snug",
        className
      )}
      {...props}
    />
  )
}

function FieldLabel({
  className,
  required = false,
  children,
  ...props
}: React.ComponentProps<typeof Label> & {
  /**
   * When true, append a destructive-colored asterisk after the label text — the standard
   * required-field affordance the full-page forms and dialogs share. The asterisk is `aria-hidden`
   * (a visual cue); the field's own validation is what conveys requiredness to assistive tech.
   */
  required?: boolean
}) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        "group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border *:data-[slot=field]:p-2.5 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10",
        "has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col",
        className
      )}
      {...props}
    >
      {children}
      {required ? (
        <span aria-hidden="true" className="text-destructive">
          *
        </span>
      ) : null}
    </Label>
  )
}

function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 text-sm font-medium group-data-[disabled=true]/field:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "text-left text-sm leading-normal font-normal text-muted-foreground group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5",
        "last:mt-0 nth-last-2:-mt-1",
        "[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className
      )}
      {...props}
    />
  )
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        "relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2",
        className
      )}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="relative mx-auto block w-fit bg-background px-2 text-muted-foreground"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  )
}

function FieldError({
  className,
  children,
  errors,
  id,
  ...props
}: React.ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>
}) {
  // Take the Field's stable error id so the invalid control can point its `aria-describedby` /
  // `aria-errormessage` here. An explicit `id` prop still wins for callers that manage it themselves.
  const fieldErrorId = useContext(FieldContext)?.errorId
  const content = useMemo(() => {
    if (children) {
      return children
    }

    if (!errors?.length) {
      return null
    }

    const uniqueErrors = [
      ...new Map(errors.map((error) => [error?.message, error])).values(),
    ]

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map(
          (error, index) =>
            error?.message && <li key={index}>{error.message}</li>
        )}
      </ul>
    )
  }, [children, errors])

  if (!content) {
    return null
  }

  return (
    <div
      role="alert"
      id={id ?? fieldErrorId}
      data-slot="field-error"
      className={cn("text-sm font-normal text-destructive", className)}
      {...props}
    >
      {content}
    </div>
  )
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
  useFieldErrorLink,
}
