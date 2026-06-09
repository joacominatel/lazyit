"use client";

import {
  Component,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { CopyButton } from "@/components/copy-button";

/**
 * MermaidDiagram — the block-level renderer for a ` ```mermaid ` fenced block in `MarkdownView`
 * (issue #310, ADR-0049). Mirrors `CodeBlock`: it is a custom React component that runs **after**
 * `rehype-sanitize`, so the sanitizer never sees the diagram source or the generated SVG and
 * `SANITIZE_SCHEMA` stays untouched — SEC-003 (stored XSS via KB Markdown) is preserved by
 * construction, and `rehype-raw` is never enabled.
 *
 * Security posture (SEC-003):
 *  - mermaid is initialised with `securityLevel: 'strict'` — it sanitises its own SVG output,
 *    HTML labels are disabled, and **no** click-handlers / `bindFunctions` are produced, so an
 *    untrusted diagram can neither inject markup nor wire script.
 *  - `startOnLoad: false` — we never let mermaid auto-scan the DOM; rendering is explicit and
 *    off-DOM via `mermaid.render(id, text)`, whose returned string is the only thing mounted.
 *  - mermaid is a heavy, browser-only library (it touches `document`/`DOMPurify`), so it is
 *    imported lazily inside an effect — never at module scope — which also keeps it out of the
 *    SSR pass and out of every route bundle except the ones that actually mount a diagram.
 *
 * A malformed diagram degrades to a graceful inline error (with the raw source still copyable),
 * never a crash: render rejections are caught here, and an additional `MermaidErrorBoundary`
 * wraps the surface so even a throw during commit shows the same calm fallback.
 */

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error" };

/**
 * Singleton mermaid loader. `mermaid.initialize` is idempotent and global, so we configure it
 * exactly once and share the module across every diagram on the page. Importing inside this
 * promise (not at module scope) keeps mermaid off the server and out of unrelated bundles.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(dark: boolean) {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // `theme: 'base'` lets the diagram inherit a neutral palette that reads on the warm-bone
        // surface in both themes; the dark flag only flips it to mermaid's dark base. Colour is
        // mermaid's own (decorative, glyph-like), so it does not violate ADR-0049 §4 text-AA.
        theme: dark ? "dark" : "base",
        fontFamily: "inherit",
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * `mounted` via `useSyncExternalStore` — the idiomatic React 19 SSR guard this repo uses (see
 * `mode-banner.tsx`), so we avoid a `setState`-in-effect. The server snapshot is `false`, so
 * mermaid (browser-only) never runs during SSR and there is no hydration mismatch.
 */
const subscribeNoop = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

function DiagramSurface({ children }: { children: ReactNode }) {
  return (
    <div className="not-prose my-4 overflow-hidden rounded-md border bg-muted/40">
      {children}
    </div>
  );
}

function DiagramPlaceholder({ label }: { label: string }) {
  return (
    <DiagramSurface>
      <div className="flex min-h-[6rem] items-center justify-center px-4 py-6">
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </DiagramSurface>
  );
}

function MermaidError({ value }: { value: string }) {
  const t = useTranslations("shared");
  return (
    <DiagramSurface>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <ExclamationTriangleIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {t("mermaid.renderError")}
        </span>
        <span className="ml-auto">
          <CopyButton
            value={value}
            label={t("code.copyCode")}
            toastMessage={t("code.copied")}
          />
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-sm leading-relaxed text-muted-foreground">
        {value}
      </pre>
    </DiagramSurface>
  );
}

/**
 * Last line of defence: if rendering ever throws during React's commit phase (rather than
 * rejecting the render promise we already catch), this boundary shows the same calm fallback
 * instead of tearing down the whole article. The caller sets `key={value}` so editing a broken
 * diagram remounts the boundary and recovers.
 */
class MermaidErrorBoundary extends Component<
  { value: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <MermaidError value={this.props.value} />;
    }
    return this.props.children;
  }
}

function MermaidRenderer({ value }: { value: string }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const t = useTranslations("shared");
  // A DOM-id-safe, render-stable id for mermaid (it injects a transient element keyed by this).
  const rawId = useId();
  const diagramId = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // `loading` carries the value+dark it was requested for, so a prop change is reflected by the
  // render path (not a setState-in-effect): if the ready/error result is stale relative to the
  // current value/dark, we fall back to the loading view until the effect catches up.
  const [result, setResult] = useState<{
    forValue: string;
    dark: boolean;
    state: RenderState;
  }>({ forValue: value, dark, state: { status: "loading" } });
  // Drop a stale async result if the value/theme changes mid-flight (or the node unmounts).
  const renderToken = useRef(0);

  useEffect(() => {
    const token = ++renderToken.current;
    let cancelled = false;

    loadMermaid(dark)
      .then(async (mermaid) => {
        // `parse` validates syntax first so a malformed diagram fails fast and cleanly.
        await mermaid.parse(value);
        const { svg } = await mermaid.render(diagramId, value);
        if (!cancelled && token === renderToken.current) {
          setResult({ forValue: value, dark, state: { status: "ready", svg } });
        }
      })
      .catch(() => {
        if (!cancelled && token === renderToken.current) {
          setResult({ forValue: value, dark, state: { status: "error" } });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [value, dark, diagramId]);

  // A result for an older value/theme is stale → show loading until the effect reconciles.
  const stale = result.forValue !== value || result.dark !== dark;
  const state: RenderState = stale ? { status: "loading" } : result.state;

  if (state.status === "error") {
    return <MermaidError value={value} />;
  }

  if (state.status === "loading") {
    return <DiagramPlaceholder label={t("mermaid.rendering")} />;
  }

  return (
    <DiagramSurface>
      {/* The SVG is mermaid's own strict-sanitised output (securityLevel: 'strict'); it never
          passes through rehype-sanitize because this component runs after it, mirroring CodeBlock.
          [&_svg]:max-w-full keeps a wide diagram inside the paper surface. */}
      <div
        role="img"
        aria-label={t("mermaid.ariaLabel")}
        className="flex justify-center overflow-x-auto p-4 [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </DiagramSurface>
  );
}

/**
 * Public entry. Guards against SSR (mermaid is browser-only) by deferring the actual render to
 * after mount, and wraps the renderer in an error boundary so a malformed diagram can never crash
 * the article view or the editor preview.
 */
export function MermaidDiagram({ value }: { value: string }) {
  const mounted = useMounted();
  const t = useTranslations("shared");

  if (!mounted) {
    // SSR / first paint: a quiet placeholder of roughly the right height — no mermaid on the
    // server, no hydration mismatch.
    return <DiagramPlaceholder label={t("mermaid.rendering")} />;
  }

  return (
    <MermaidErrorBoundary value={value} key={value}>
      <MermaidRenderer value={value} />
    </MermaidErrorBoundary>
  );
}
