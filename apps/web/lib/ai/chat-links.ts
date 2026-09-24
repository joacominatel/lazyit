import { safeInternalPath } from "@/lib/utils/safe-redirect";

/**
 * How the chat renders a link the model wrote (frontend.md §5.5, synthesis §4.10). Model text can be
 * steered by prompt-injected content, so:
 *   - a same-origin relative path is an in-app link (through the router);
 *   - an explicit `[text](https://…)` link opens in a new tab with no opener and no referrer, and shows
 *     its host so the user sees where it goes;
 *   - a bare URL the markdown auto-linked (its text IS the URL) stays plain text — never auto-linked;
 *   - any other scheme (`javascript:`, `data:`, `mailto:`, …) is plain text.
 */
export type ChatLink =
  | { kind: "internal"; href: string }
  | { kind: "external"; href: string; host: string }
  | { kind: "text" };

export function classifyLink(href: string | undefined | null, text: string): ChatLink {
  if (typeof href !== "string" || href.trim() === "") return { kind: "text" };
  const value = href.trim();

  if (value.startsWith("/")) {
    return safeInternalPath(value) === value ? { kind: "internal", href: value } : { kind: "text" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "text" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "text" };
  if (url.username || url.password) return { kind: "text" };

  // GFM auto-links `https://…` and `www.…` literals: the link's text is the URL itself.
  const norm = (s: string) => s.replace(/\/+$/, "");
  const shown = norm(text.trim());
  const targets = new Set([norm(value), norm(url.href)]);
  const isAutolink =
    targets.has(shown) || targets.has(`http://${shown}`) || targets.has(`https://${shown}`);
  if (isAutolink) return { kind: "text" };

  return { kind: "external", href: url.href, host: url.host };
}
