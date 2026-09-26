import { describe, expect, test } from "bun:test";

import {
  apiConnectOrigin,
  buildContentSecurityPolicy,
  CSP_ENFORCED,
  CSP_HEADER,
  cspDirectives,
  disableZodJit,
  generateNonce,
} from "./csp";

// Pins the web Content-Security-Policy (#1440). A change to any directive must be deliberate: edit
// the expectation here AND docs/06-security/content-security-policy.md in the same change.

const NONCE = "bm9uY2UtdmFsdWUtMTIzNA==";
const prod = { nonce: NONCE, isDev: false, apiUrl: "/api" } as const;

/** The directive named `name`, or undefined. */
function directive(policy: string[], name: string): string | undefined {
  return policy.find((d) => d.split(" ")[0] === name);
}

describe("the pinned policy (production, same-origin /api)", () => {
  test("is exactly this, in this order (report-only delivery)", () => {
    expect(cspDirectives({ ...prod, enforced: false })).toEqual([
      "default-src 'self'",
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self'",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-src 'none'",
    ]);
  });

  test("the enforcing policy adds frame-ancestors 'none' (report-only cannot carry it)", () => {
    const enforced = cspDirectives({ ...prod, enforced: true });
    expect(enforced.at(-1)).toBe("frame-ancestors 'none'");
    expect(directive(cspDirectives({ ...prod, enforced: false }), "frame-ancestors")).toBeUndefined();
  });

  test("scripts run by nonce only: no 'unsafe-inline' and no 'unsafe-eval' in production", () => {
    const scriptSrc = directive(cspDirectives(prod), "script-src")!;
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toMatch(/'unsafe-eval'/);
  });

  test("images never load from a remote host (the SEC-084 tracking-pixel class)", () => {
    expect(directive(cspDirectives(prod), "img-src")).toBe("img-src 'self' data: blob:");
  });

  test("style-src carries no nonce, which would silently disable its 'unsafe-inline'", () => {
    expect(directive(cspDirectives(prod), "style-src")).not.toContain("nonce-");
  });

  test("no upgrade-insecure-requests: plain-HTTP LAN instances must keep working", () => {
    expect(buildContentSecurityPolicy(prod)).not.toContain("upgrade-insecure-requests");
  });

  test("the header value is the directives joined by '; '", () => {
    expect(buildContentSecurityPolicy(prod)).toBe(cspDirectives(prod).join("; "));
  });
});

describe("delivery mode", () => {
  test("ships report-only today, and the header name follows the switch", () => {
    expect(CSP_ENFORCED).toBe(false);
    expect(CSP_HEADER).toBe("Content-Security-Policy-Report-Only");
  });

  test("the default for `enforced` is the module switch", () => {
    expect(cspDirectives(prod)).toEqual(cspDirectives({ ...prod, enforced: CSP_ENFORCED }));
  });
});

describe("dev mode", () => {
  test("adds 'unsafe-eval' to script-src for React's dev tooling, and only there", () => {
    const dev = cspDirectives({ ...prod, isDev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(dev.filter((d) => d.includes("'unsafe-eval'"))).toHaveLength(1);
  });
});

describe("connect-src follows the browser's API base URL", () => {
  test("relative /api (every Docker image, ADR-0026) needs nothing beyond 'self'", () => {
    expect(apiConnectOrigin("/api")).toBeNull();
  });

  test("an absolute URL adds its origin (path and trailing slash dropped)", () => {
    expect(apiConnectOrigin("https://api.example.com/v1/")).toBe("https://api.example.com");
    expect(directive(cspDirectives({ ...prod, apiUrl: "http://localhost:3001" }), "connect-src")).toBe(
      "connect-src 'self' http://localhost:3001",
    );
  });

  test("unset falls back to the client's own default, http://localhost:3001", () => {
    expect(apiConnectOrigin(undefined)).toBe("http://localhost:3001");
  });

  test("garbage yields no extra source rather than a broken policy", () => {
    expect(apiConnectOrigin("http://")).toBeNull();
    expect(apiConnectOrigin("javascript:alert(1)")).toBeNull();
  });
});

describe("generateNonce", () => {
  test("is 16 random bytes, base64-encoded, and fresh on every call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(atob(a)).toHaveLength(16);
    expect(a).not.toBe(b);
  });
});

describe("disableZodJit", () => {
  test("creates zod's global config when zod has not loaded yet", () => {
    const target: { __zod_globalConfig?: Record<string, unknown> } = {};
    disableZodJit(target);
    expect(target.__zod_globalConfig).toEqual({ jitless: true });
  });

  test("merges into an existing config without dropping other settings", () => {
    const target = { __zod_globalConfig: { customError: "keep" } as Record<string, unknown> };
    disableZodJit(target);
    expect(target.__zod_globalConfig).toEqual({ customError: "keep", jitless: true });
  });
});
