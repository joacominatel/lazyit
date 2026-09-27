import type { AiWebSource } from "@lazyit/shared";

/**
 * Web search sources under an assistant message (#1389; docs/ai-assistant/frontend.md). The API already
 * drops anything but `http(s)` (`AiWebSourceListSchema`); the web re-checks before it renders a link, so
 * a `javascript:` or `data:` URL can never become an `href` even from an older or faulty API. The title is
 * other-authored text: shown as plain text, never as Markdown or HTML.
 */

export interface WebSourceLink {
  href: string;
  /** The page title, or the host when the provider gave none. */
  label: string;
  host: string;
}

/** The link for a source, or null when its URL is not an absolute `http:` / `https:` URL. */
export function webSourceLink(source: Pick<AiWebSource, "url" | "title">): WebSourceLink | null {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.hostname === "") return null;
  const host = url.hostname.replace(/^www\./, "");
  const title = (source.title ?? "").replace(/\s+/g, " ").trim();
  return { href: url.href, label: title || host, host };
}

/** The links for a list of sources: unsafe ones dropped, duplicates (same href) dropped. */
export function webSourceLinks(sources: readonly Pick<AiWebSource, "url" | "title">[]): WebSourceLink[] {
  const seen = new Set<string>();
  const out: WebSourceLink[] = [];
  for (const source of sources) {
    const link = webSourceLink(source);
    if (!link || seen.has(link.href)) continue;
    seen.add(link.href);
    out.push(link);
  }
  return out;
}
