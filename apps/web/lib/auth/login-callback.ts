import { safeInternalPath } from "@/lib/utils/safe-redirect";

/**
 * Where route protection (`proxy.ts`) sends a signed-out visitor: `/login` with the page they asked for
 * as `callbackUrl` — its path AND its query string. Keeping the query is what lets the OAuth consent page
 * (`/oauth/authorize?client_id=…&redirect_uri=…&code_challenge=…&state=…`) survive a sign-in: without
 * it the authorization request's parameters were lost and the flow dead-ended (#1315, W3-9;
 * docs/ai-assistant/frontend.md §10 risk 2). Any other page with a filter in its URL benefits the same way.
 *
 * `/login` applies the open-redirect guard again when it reads the parameter (#495). Here the value is
 * the request's own same-origin path, so it always passes; should it ever not, only the path is kept.
 * Relative on purpose (#1052); the proxy resolves it against the request origin.
 */
export function loginCallbackPath(location: {
  pathname: string;
  search: string;
}): string {
  const raw = `${location.pathname}${location.search}`;
  const destination =
    safeInternalPath(raw) === raw ? raw : safeInternalPath(location.pathname);
  const params = new URLSearchParams({ callbackUrl: destination });
  return `/login?${params.toString()}`;
}
