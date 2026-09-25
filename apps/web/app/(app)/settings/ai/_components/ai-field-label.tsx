"use client";

import type { ReactNode } from "react";
import { HelpTip } from "@/components/help-tip";
import { FieldLabel } from "@/components/ui/field";

/**
 * A field label followed by its "?" help tip (#1407). The tip sits OUTSIDE the `<label>`, so opening
 * it never moves focus into the control, and the label keeps naming the control on its own.
 */
export function AiFieldLabel({
  htmlFor,
  children,
  help,
  href,
  className,
}: {
  htmlFor: string;
  children: string;
  help?: ReactNode;
  href?: string;
  className?: string;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <FieldLabel htmlFor={htmlFor} className={className}>
        {children}
      </FieldLabel>
      {help ? (
        <HelpTip topic={children} href={href}>
          {help}
        </HelpTip>
      ) : null}
    </div>
  );
}

