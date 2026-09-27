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
import { Lightbox } from "@/components/markdown-lightbox";

/**
 * MermaidDiagram — the block-level renderer for a ` ```mermaid ` fenced block in `MarkdownView`
 * (issue #310, ADR-0049). Mirrors `CodeBlock`: it is a custom React component that runs **after**
 * `rehype-sanitize`, so the sanitizer never sees the diagram source or the generated SVG and
 * `SANITIZE_SCHEMA` stays untouched — SEC-003 (stored XSS via KB Markdown) is preserved by
 * construction, and `rehype-raw` is never enabled.
 *
 * Security posture (SEC-003):
 *  - mermaid is initialised with `securityLevel: 'strict'` — it sanitises its own SVG output and
 *    **no** click-handlers / `bindFunctions` are produced, so an untrusted diagram cannot wire script.
 *  - labels render as SVG `<text>`, not HTML: the root `htmlLabels: false`, which is also listed in
 *    `secure` so a diagram's `%%{init}%%` directive or front-matter `config:` cannot turn HTML
 *    labels back on (SEC-084). With HTML labels, an author's `<img src="https://…">` in a node
 *    label survives strict mode and loads from the reader's browser — a tracking pixel.
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
 * Singleton mermaid loader. The module is imported once and shared across every diagram on the
 * page; importing inside this promise (not at module scope) keeps mermaid off the server and out of
 * unrelated bundles. `mermaid.initialize` is global and rebuilds the site config from mermaid's
 * defaults on every call, so it is re-run whenever the app theme flips — otherwise a diagram keeps
 * the theme of whichever mode it was first loaded in.
 */
/** Mermaid's own default `secure` list (mermaid 12 `config.schema.yaml`), kept when extending it. */
const MERMAID_DEFAULT_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
];

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let initializedDark: boolean | null = null;

export function loadMermaid(dark: boolean) {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => mermaid);
  }
  return mermaidPromise.then((mermaid) => {
    if (initializedDark !== dark) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // Mermaid 12 look (#1402): light mode sets no `theme`, so each diagram type gets
        // mermaid's own default — `redux-color` + the `neo` look for flowchart, class, state, ER,
        // sequence and the rest; `default` for the others. Dark mode needs an explicit theme
        // (mermaid does not follow the page's colour scheme), so it takes the matching dark
        // variant, `redux-dark-color`. Layout is left at mermaid's default (ELK). Colour is
        // mermaid's own (decorative, glyph-like), so it does not violate ADR-0049 §4 text-AA.
        ...(dark ? { theme: "redux-dark-color" as const } : {}),
        fontFamily: "inherit",
        // SEC-084: the ROOT option. `flowchart.htmlLabels` is deprecated (mermaid ≥ 11.12.3) and
        // does not stop flowchart node labels rendering as HTML — do not move it back there.
        htmlLabels: false,
        // Keys a diagram's directive / front-matter config may not override. Setting `secure`
        // replaces mermaid's default list, so the defaults are repeated before `htmlLabels`.
        secure: [...MERMAID_DEFAULT_SECURE_KEYS, "htmlLabels"],
      });
      initializedDark = dark;
    }
    return mermaid;
  });
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
          [&_svg]:max-w-full keeps a wide diagram inside the paper surface.
          #1106: click to enlarge in the native-`<dialog>` lightbox (no dep). */}
      {/* ponytail: the thumbnail and the enlarged copy share the same SVG markup, so their internal
          element ids are duplicated in the DOM. This is benign — `url(#id)` marker/def references
          resolve to the first (identical) occurrence, so both copies render correctly; a
          full-fidelity zoom would re-render the diagram under a fresh id namespace. */}
      <Lightbox
        label={t("lightbox.zoom")}
        className="w-full"
        zoomed={
          <div
            role="img"
            aria-label={t("mermaid.ariaLabel")}
            className="flex justify-center p-2 [&_svg]:h-auto [&_svg]:max-h-[86vh] [&_svg]:w-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        }
      >
        <div
          role="img"
          aria-label={t("mermaid.ariaLabel")}
          className="flex justify-center overflow-x-auto p-4 [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      </Lightbox>
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
