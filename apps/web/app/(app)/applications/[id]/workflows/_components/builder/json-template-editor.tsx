"use client";

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  autocompletion,
} from "@codemirror/autocomplete";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { WorkflowStep } from "@lazyit/shared";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { useMemo } from "react";
import { buildContextTokens } from "@/lib/workflow/context-tokens";

/**
 * The ADVANCED data-mapping editor (issue #339) — a real code editor for the raw template, replacing
 * the bare textarea. Built on CodeMirror 6 via `@uiw/react-codemirror` (see
 * `docs/workflow-engine/frontend.md` library note): JSON syntax highlighting + inline JSON lint
 * (`jsonParseLinter`), `{{ }}` token autocompletion from the SAME source as the field picker
 * (`buildContextTokens`, prior-steps-scoped), and distinct highlighting of `{{ token }}` spans.
 *
 * The output is a plain string — identical to what the bare textarea produced — so it stays compatible
 * with the mapping/template contract and round-trips through the field-picker ↔ advanced toggle.
 *
 * Loaded via `next/dynamic({ ssr: false })` from the data-mapping editor so its (client-only) bundle
 * never ships on the initial builder route and never runs during SSR.
 *
 * SEC-A5: the editor only ever renders the admin-authored template text the operator types (never a
 * resolved runtime value), and CodeMirror builds its DOM imperatively — there is no raw-HTML injection
 * anywhere in this surface.
 */

/** Highlight `{{ … }}` spans so templates stand out from the surrounding JSON. */
const TOKEN_MARK = Decoration.mark({ class: "cm-lazyit-token" });
const TOKEN_RE = /\{\{\s*[^}]*?\s*\}\}/g;

function buildTokenDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null = TOKEN_RE.exec(text);
    while (match !== null) {
      ranges.push(TOKEN_MARK.range(from + match.index, from + match.index + match[0].length));
      match = TOKEN_RE.exec(text);
    }
  }
  // RangeSetBuilder requires ascending, non-overlapping ranges (the matches already are).
  for (const range of ranges) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

const tokenHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildTokenDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildTokenDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** The visual theme for our token marks (token-backed colours, not raw palette — ADR-0049). */
const lazyitTheme = EditorView.theme({
  "&": { fontSize: "0.75rem" },
  ".cm-content": { fontFamily: "var(--font-mono, monospace)" },
  ".cm-lazyit-token": {
    color: "var(--primary)",
    backgroundColor: "color-mix(in oklab, var(--primary) 12%, transparent)",
    borderRadius: "3px",
  },
});

/** A `{{ … }}` autocomplete source: when the caret is inside an open `{{`, offer the context tokens. */
function makeTokenCompletionSource(priorSteps: readonly WorkflowStep[]) {
  const options: Completion[] = buildContextTokens(priorSteps).map((token) => ({
    label: token.path,
    detail: token.label,
    type: "variable",
    // Replace whatever path fragment was typed; the surrounding braces are kept.
    apply: token.path,
  }));

  return (context: CompletionContext): CompletionResult | null => {
    // Match an open `{{` followed by the partial path the user is typing (no closing braces yet).
    const before = context.matchBefore(/\{\{\s*[\w.-]*/);
    if (!before) return null;
    // Only trigger when there is a real `{{` opener (not just stray word chars).
    if (!before.text.includes("{{")) return null;
    // The completion replaces from just after the `{{ ` opener to the caret.
    const openerMatch = before.text.match(/\{\{\s*/);
    const fromOffset = openerMatch ? openerMatch[0].length : 0;
    return {
      from: before.from + fromOffset,
      options,
      validFor: /^[\w.-]*$/,
    };
  };
}

export default function JsonTemplateEditor({
  value,
  onChange,
  priorSteps = [],
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  priorSteps?: readonly WorkflowStep[];
  ariaLabel?: string;
}) {
  const { resolvedTheme } = useTheme();

  const extensions = useMemo(
    () => [
      json(),
      linter(jsonParseLinter()),
      lintGutter(),
      autocompletion({
        override: [makeTokenCompletionSource(priorSteps)],
      }),
      tokenHighlighter,
      lazyitTheme,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(
        ariaLabel ? { "aria-label": ariaLabel } : {},
      ),
    ],
    [priorSteps, ariaLabel],
  );

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          autocompletion: false, // our override source is configured above
          searchKeymap: false,
        }}
        minHeight="140px"
        maxHeight="360px"
      />
    </div>
  );
}
