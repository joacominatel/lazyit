"use client";

import {
  CodeBracketIcon,
  EyeIcon,
  ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/markdown-view";
import { cn } from "@/lib/utils";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
}

/** The three editor layouts. `split` = source + live preview side-by-side; `write` = source
 *  full-width; `preview` = rendered full-width. The toggle (issue #310) lets the author trade
 *  the split for a single full-width pane to gain room while writing or while proofing. */
type ViewMode = "split" | "write" | "preview";

const MODES: { mode: ViewMode; icon: typeof CodeBracketIcon; labelKey: string }[] =
  [
    { mode: "split", icon: ViewColumnsIcon, labelKey: "editor.viewSplit" },
    { mode: "write", icon: CodeBracketIcon, labelKey: "editor.viewWrite" },
    { mode: "preview", icon: EyeIcon, labelKey: "editor.viewPreview" },
  ];

/**
 * Markdown editor: a plain textarea next to a live preview (ADR-0021 keeps this deliberately
 * lightweight — no TipTap/WYSIWYG). Controlled, so it drops into react-hook-form via a
 * `Controller`.
 *
 * A quiet segmented toggle (issue #310, ADR-0049) switches the pane between the side-by-side
 * split, a full-width source pane, and a full-width rendered preview — so the author can gain
 * horizontal room for either writing or proofing. Defaults to `split`. Mermaid fences and code
 * blocks render in the preview exactly as they do in the published article (same `MarkdownView`).
 */
export function MarkdownEditor({
  value,
  onChange,
  id,
  placeholder,
  invalid,
}: MarkdownEditorProps) {
  const t = useTranslations("shared");
  const [mode, setMode] = useState<ViewMode>("split");

  const showSource = mode !== "preview";
  const showPreview = mode !== "write";

  const textarea = (
    <Textarea
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder ?? t("editor.markdownPlaceholder")}
      aria-invalid={invalid || undefined}
      spellCheck
      className="min-h-[420px] resize-y font-mono text-sm"
    />
  );

  const preview = (
    <div className="min-h-[420px] overflow-auto rounded-md border bg-muted/30 p-4">
      {value.trim() ? (
        <MarkdownView content={value} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("editor.previewHint")}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Quiet segmented control — ghost buttons on a muted track, the active one gets the
          card surface + ring. Restraint-consistent: no colour, glyph + label only. */}
      <div
        role="group"
        aria-label={t("editor.viewToggleLabel")}
        className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5"
      >
        {MODES.map(({ mode: m, icon: Icon, labelKey }) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={active}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] font-medium transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                active
                  ? "bg-card text-foreground shadow-e1 ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(labelKey)}
            </button>
          );
        })}
      </div>

      <div
        className={cn(
          "grid gap-3",
          mode === "split" ? "md:grid-cols-2" : "grid-cols-1",
        )}
      >
        {showSource && textarea}
        {showPreview && preview}
      </div>
    </div>
  );
}
