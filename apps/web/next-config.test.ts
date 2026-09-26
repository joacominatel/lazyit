import { describe, expect, test } from "bun:test";

import nextConfig from "./next.config";

// The static security headers (#501) and how they sit next to the proxy's per-request policy (#1440).

describe("next.config security headers", () => {
  test("every route gets the ENFORCED baseline CSP: frame-ancestors 'none', nothing more", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeDefined();
    const csp = all!.headers.filter((h) => h.key.toLowerCase().startsWith("content-security-policy"));
    // Exactly one, enforcing. The content policy is per-request (a nonce), so it cannot live here: it
    // comes from proxy.ts, and a static script-src would block every page's scripts.
    expect(csp).toEqual([{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }]);
  });
});
