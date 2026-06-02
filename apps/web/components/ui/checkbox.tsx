"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { CheckIcon, MinusIcon } from "@heroicons/react/16/solid"

import { cn } from "@/lib/utils"

/**
 * A square checkbox built on Radix (the `radix-ui` meta-package, mirroring `switch.tsx`). Supports
 * the tri-state Radix contract — `checked` may be `true`, `false`, or `"indeterminate"` — so a
 * "select all" header can show a partial-selection dash (`MinusIcon`) distinct from a full check.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        {props.checked === "indeterminate" ? (
          <MinusIcon className="size-3.5" />
        ) : (
          <CheckIcon className="size-3.5" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
