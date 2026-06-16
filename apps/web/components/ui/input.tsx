"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { useFieldErrorLink } from "@/components/ui/field"

function Input({
  className,
  type,
  "aria-describedby": describedBy,
  "aria-errormessage": errorMessage,
  ...props
}: React.ComponentProps<"input">) {
  // When rendered inside an invalid `Field`, link this input to its `FieldError` (WCAG 1.3.1 /
  // 3.3.1) by merging the error id into `aria-describedby` / `aria-errormessage`. Outside a `Field`,
  // or while valid, the caller's own values pass through unchanged.
  const errorLink = useFieldErrorLink({
    "aria-describedby": describedBy,
    "aria-errormessage": errorMessage,
  })

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
      {...errorLink}
    />
  )
}

export { Input }
