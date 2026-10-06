"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { HelpTip } from "@/components/help-tip";
import { FieldLabel } from "@/components/ui/field";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

/**
 * The Settings page primitives (#1533) — one frame for every settings surface, so a page reads as
 * "title, one line, state" instead of a wall of explanation. The text rules they exist to enforce live
 * in `docs/04-development/ledger-design-language.md` §4c:
 *
 *  - a section shows its title, ONE short summary line and its state badge — nothing else as prose;
 *  - the longer explanation goes into the "?" {@link HelpTip} beside the title or the label;
 *  - one save model per section — a form's explicit Save sits in the section's footer
 *    ({@link SettingsSaveBar}); a standalone toggle that already autosaves keeps doing so.
 *
 * Same surface as `DetailPanel` (`bg-card`, `ring-1 ring-foreground/10`, `rounded-xl`), split into a
 * header, a hairline-separated body and an optional footer.
 */
export function SettingsSection({
  title,
  summary,
  status,
  help,
  helpHref,
  actions,
  footer,
  className,
  children,
  "aria-label": ariaLabel,
}: {
  /** The section heading (also names its "?" tip). */
  title: string;
  /** The ONE short line saying what the section does (≤ ~12 words). */
  summary?: ReactNode;
  /** The state badge beside the title — usually a {@link SettingsStatus}. */
  status?: ReactNode;
  /** The longer explanation, behind a "?" beside the title. */
  help?: ReactNode;
  /** A Manual page the tip's "Learn more" opens. */
  helpHref?: string;
  /** Trailing header control(s): a switch, a button, a link. */
  actions?: ReactNode;
  /** The section footer — normally a {@link SettingsSaveBar}. */
  footer?: ReactNode;
  className?: string;
  /** The body; omitted for a header-only section (e.g. a single action). */
  children?: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        "rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-sm font-semibold">{title}</h2>
            {help ? (
              <HelpTip topic={title} href={helpHref} className="-mx-1">
                {help}
              </HelpTip>
            ) : null}
            {status}
          </div>
          {summary ? (
            <div className="text-sm text-muted-foreground">{summary}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children ? (
        <div className="space-y-4 border-t px-4 py-4">{children}</div>
      ) : null}
      {footer}
    </section>
  );
}

/** The state a settings section can be in, as shown in its header badge. */
export type SettingsState = "on" | "off" | "configured";

const STATE_TONE = {
  on: "success",
  off: "neutral",
  configured: "info",
} as const;

/** The On / Off / Configured badge for a section or page header. */
export function SettingsStatus({ state }: { state: SettingsState }) {
  const t = useTranslations("settings.section.status");
  return <StatusBadge tone={STATE_TONE[state]}>{t(state)}</StatusBadge>;
}

/**
 * One setting: its label (and optional "?" tip) on the left, its control on the right. Rows stack with
 * hairline separators, so a run of them reads as one list.
 */
export function SettingRow({
  label,
  htmlFor,
  help,
  helpHref,
  note,
  className,
  children,
}: {
  label: string;
  /** The control's id, so the label names it. Omit when the control carries its own name. */
  htmlFor?: string;
  help?: ReactNode;
  helpHref?: string;
  /** A short visible line under the label — only for a constraint or a risk the user needs now. */
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t py-2.5 first:border-t-0 first:pt-0 last:pb-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <SettingLabel htmlFor={htmlFor} help={help} href={helpHref}>
          {label}
        </SettingLabel>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A field label followed by its "?" tip (#1407). The tip sits OUTSIDE the `<label>`, so opening it
 * never moves focus into the control, and the label keeps naming the control on its own.
 */
export function SettingLabel({
  htmlFor,
  children,
  help,
  href,
  className,
}: {
  htmlFor?: string;
  children: string;
  help?: ReactNode;
  href?: string;
  className?: string;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {htmlFor ? (
        <FieldLabel htmlFor={htmlFor} className={className}>
          {children}
        </FieldLabel>
      ) : (
        <span className={cn("text-sm font-medium", className)}>{children}</span>
      )}
      {help ? (
        <HelpTip topic={children} href={href}>
          {help}
        </HelpTip>
      ) : null}
    </div>
  );
}

/**
 * A section footer holding its explicit Save: an optional muted note on the left (dirty state, a
 * one-line consequence), the buttons on the right.
 */
export function SettingsSaveBar({
  note,
  className,
  children,
}: {
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3",
        className,
      )}
    >
      {note ? (
        <div className="me-auto flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
          {note}
        </div>
      ) : null}
      {children}
    </div>
  );
}
