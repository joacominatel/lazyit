"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { InformationCircleIcon, ExclamationTriangleIcon, XCircleIcon } from "@heroicons/react/16/solid"
import { ArrowPathIcon } from "@heroicons/react/24/outline"
import { DrawnCheck } from "@/components/drawn-check"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        // The one success flourish: the check draws once on mount (animate-check-draw,
        // the reserved --ease-spring), reduced-motion-safe. text-success keeps the tone on
        // the glyph, never small coloured text. Tasteful, not noisy.
        success: (
          <DrawnCheck className="size-4 text-success" />
        ),
        info: (
          <InformationCircleIcon className="size-4" />
        ),
        warning: (
          <ExclamationTriangleIcon className="size-4" />
        ),
        error: (
          <XCircleIcon className="size-4" />
        ),
        loading: (
          <ArrowPathIcon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
