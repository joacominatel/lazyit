import type { OAuthScope } from "@lazyit/shared";

/**
 * The `oauth.scopes.<key>` message key of a scope. i18n keys cannot contain dots (next-intl reads them as
 * nesting), so `lazyit.read` → `read`. Scope ids are data; only their display strings are translated.
 */
export function scopeMessageKey(scope: OAuthScope): "read" | "write" | "admin" {
  switch (scope) {
    case "lazyit.admin":
      return "admin";
    case "lazyit.write":
      return "write";
    default:
      return "read";
  }
}
