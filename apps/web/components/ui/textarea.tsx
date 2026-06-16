"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { useFieldErrorLink } from "@/components/ui/field"

function Textarea({
  className,
  "aria-describedby": describedBy,
  "aria-errormessage": errorMessage,
  ...props
}: React.ComponentProps<"textarea">) {
  // When rendered inside an invalid `Field`, link this textarea to its `FieldError` (WCAG 1.3.1 /
  // 3.3.1) by merging the error id into `aria-describedby` / `aria-errormessage`. Outside a `Field`,
  // or while valid, the caller's own values pass through unchanged.
  const errorLink = useFieldErrorLink({
    "aria-describedby": describedBy,
    "aria-errormessage": errorMessage,
  })

  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
      {...errorLink}
    />
  )
}

export { Textarea }
