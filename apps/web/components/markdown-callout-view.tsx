"use client";

import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  LightBulbIcon,
  MegaphoneIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  CALLOUT_VARIANTS,
  type CalloutVariant,
} from "@/components/markdown-callout";
import { cn } from "@/lib/utils";

/**
 * Callout — the React side of a GitHub-style admonition (#1106 Phase 1). The post-sanitize
 * `rehypeCallouts` pass mints a `callout` element carrying `variant`; `MarkdownView` maps it here.
 *
 * ADR-0049 «Activated Restraint»: colour is a TINTED SURFACE + a small glyph, never saturated body
 * text. Each variant sits on one of the existing Ledger status / categorical hues at ~10% tint with a
 * matching hairline border; the title stays on `--foreground` (always AA), the body inherits the
 * surrounding `prose`. Every token is a CSS variable, so the same classes are correct in light and
 * `.dark` with no second palette.
 *
 * The body keeps its prose styling (paragraphs, lists, links, inline code, and — inside the KB — the
 * masked secret chips / wiki-links minted by their own post-sanitize passes), because the callout is
 * an ordinary block inside `MarkdownView`'s `prose` container; only the title row opts out via
 * `not-prose`, and the body's outer margins are collapsed so the panel reads as one tidy card.
 */

/** Per-variant icon glyph + tinted-surface / border / glyph-colour classes (all literal → JIT-safe). */
const VARIANT_META: Record<
  CalloutVariant,
  {
    Icon: ComponentType<SVGProps<SVGSVGElement>>;
    surface: string;
    glyph: string;
  }
> = {
  note: {
    Icon: InformationCircleIcon,
    surface: "border-info/30 bg-info/10",
    glyph: "text-info",
  },
  tip: {
    Icon: LightBulbIcon,
    surface: "border-success/30 bg-success/10",
    glyph: "text-success",
  },
  important: {
    Icon: MegaphoneIcon,
    surface: "border-chart-3/30 bg-chart-3/10",
    glyph: "text-chart-3",
  },
  warning: {
    Icon: ExclamationTriangleIcon,
    surface: "border-warning/40 bg-warning/10",
    // `--warning` is a light amber; its AA-safe `--warning-text` tone stays legible as a glyph in
    // both themes where the raw hue would wash out on the light tint.
    glyph: "text-warning-text",
  },
  caution: {
    Icon: ExclamationCircleIcon,
    surface: "border-destructive/30 bg-destructive/10",
    glyph: "text-destructive",
  },
};

function isVariant(value: string | undefined): value is CalloutVariant {
  return (
    value !== undefined &&
    (CALLOUT_VARIANTS as readonly string[]).includes(value)
  );
}

export function Callout({
  variant,
  children,
}: {
  variant?: string;
  children?: ReactNode;
}) {
  const t = useTranslations("shared");
  // `rehypeCallouts` only ever emits a known variant; fall back to `note` defensively.
  const key: CalloutVariant = isVariant(variant) ? variant : "note";
  const meta = VARIANT_META[key];
  const { Icon } = meta;

  return (
    <div
      className={cn("my-4 rounded-md border px-4 py-3", meta.surface)}
      data-callout={key}
    >
      <div className="not-prose mb-2 flex items-center gap-2">
        <Icon className={cn("size-4 shrink-0", meta.glyph)} aria-hidden />
        <span className="text-sm font-semibold text-foreground">
          {t(`callout.${key}`)}
        </span>
      </div>
      <div className="text-foreground [&>:first-child]:mt-0 [&>:last-child]:mb-0">
        {children}
      </div>
    </div>
  );
}
