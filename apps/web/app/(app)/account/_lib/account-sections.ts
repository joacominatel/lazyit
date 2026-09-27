/**
 * The account hub's section registry (issue #1404) — pure, so the sub-navigation's visibility and
 * active-tab rules are unit-tested without rendering.
 *
 * Every entry is an EXISTING per-user surface; the hub adds no new capability. `/profile` keeps its
 * URL (#947) and joins the account sub-navigation so the caller moves between their own pages without
 * going back through the user menu.
 */

export type AccountSectionKey = "overview" | "profile" | "notifications" | "ai";

export interface AccountSection {
  key: AccountSectionKey;
  href: string;
}

/** What the caller can reach — resolved by the component from `can()` and `GET /ai/status`. */
export interface AccountNavContext {
  /** The caller holds `ai:connect`. */
  canConnectAi: boolean;
  /**
   * `GET /ai/status` answered successfully. An API without the assistant answers 404, which hides the
   * AI entry exactly like the user menu does (ADR-0097).
   */
  aiStatusAvailable: boolean;
}

const SECTIONS: readonly AccountSection[] = [
  { key: "overview", href: "/account" },
  { key: "profile", href: "/profile" },
  { key: "notifications", href: "/account/notifications" },
  { key: "ai", href: "/account/ai" },
];

/** The sections the caller sees, in display order. Fails closed: AI needs both signals. */
export function accountSections(ctx: AccountNavContext): AccountSection[] {
  return SECTIONS.filter(
    (s) => s.key !== "ai" || (ctx.canConnectAi && ctx.aiStatusAvailable),
  );
}

/**
 * The section a pathname belongs to: an exact match, or the longest section href that prefixes the
 * path on a segment boundary (so `/account/ai/x` is AI, while `/account` only matches itself and
 * `/accounting` matches nothing). Returns null for a path outside the account area.
 */
export function activeAccountSection(
  pathname: string,
  sections: readonly AccountSection[] = SECTIONS,
): AccountSectionKey | null {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  let best: AccountSection | null = null;
  for (const section of sections) {
    const matches =
      path === section.href ||
      (section.href !== "/account" && path.startsWith(`${section.href}/`));
    if (matches && (!best || section.href.length > best.href.length)) {
      best = section;
    }
  }
  return best?.key ?? null;
}

/** Who owns the caller's password, from `GET /config/status` `authMode`. */
export type PasswordOwner = "lazyit" | "identity-provider" | "unknown";

/**
 * `local` → lazyit owns the password (the `/profile` change-password panel renders, and signing out
 * revokes every session). `oidc` → the identity provider does. Anything else (an older API without
 * `authMode`, or an unexpected value) → unknown, and the hub says nothing it cannot back.
 */
export function passwordOwner(authMode: string | null | undefined): PasswordOwner {
  if (authMode === "local") return "lazyit";
  if (authMode === "oidc") return "identity-provider";
  return "unknown";
}

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Narrow next-themes' `theme` (a free string, undefined before mount) to a choice the picker shows. */
export function toThemeChoice(theme: string | null | undefined): ThemeChoice {
  return (THEME_CHOICES as readonly string[]).includes(theme ?? "")
    ? (theme as ThemeChoice)
    : "system";
}
