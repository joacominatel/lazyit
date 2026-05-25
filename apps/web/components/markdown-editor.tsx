"use client";

import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/markdown-view";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
}

/**
 * Markdown editor: a plain textarea next to a live preview (ADR-0021 keeps this
 * deliberately lightweight — no TipTap/WYSIWYG). Controlled, so it drops into
 * react-hook-form via a `Controller`.
 */
export function MarkdownEditor({
  value,
  onChange,
  id,
  placeholder = "Write in Markdown…",
  invalid,
}: MarkdownEditorProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        spellCheck
        className="min-h-[420px] resize-y font-mono text-sm"
      />
      <div className="min-h-[420px] overflow-auto rounded-md border bg-muted/30 p-4">
        {value.trim() ? (
          <MarkdownView content={value} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Preview appears here as you type.
          </p>
        )}
      </div>
    </div>
  );
}
