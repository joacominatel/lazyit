import { describe, expect, test } from "bun:test";
import {
  agentFetchInit,
  disableAmbientProxy,
  interpretGuardProbe,
  interpretProbe,
  networkFrom,
  noProxyMatches,
  proxyForUrl,
} from "./net";

describe("networkFrom — env wins over the config file, key by key", () => {
  test("reads the four keys out of a config-file map", () => {
    expect(
      networkFrom(
        {
          HTTPS_PROXY: "http://proxy.corp:3128",
          NO_PROXY: "lazyit.corp,.internal",
          LAZYIT_CA_FILE: "/etc/pki/corp-root.pem",
        },
        {},
      ),
    ).toEqual({
      httpsProxy: "http://proxy.corp:3128",
      noProxy: "lazyit.corp,.internal",
      caFile: "/etc/pki/corp-root.pem",
    });
  });

  test("an environment value overrides the file's, per key, leaving the others alone", () => {
    expect(
      networkFrom(
        { HTTPS_PROXY: "http://file-proxy:3128", LAZYIT_CA_FILE: "/from/file.pem" },
        { HTTPS_PROXY: "http://env-proxy:3128" },
      ),
    ).toEqual({ httpsProxy: "http://env-proxy:3128", caFile: "/from/file.pem" });
  });

  test("the lowercase spellings are honoured, because half the world writes https_proxy", () => {
    expect(networkFrom({}, { https_proxy: "http://p:8080", no_proxy: "*" })).toEqual({
      httpsProxy: "http://p:8080",
      noProxy: "*",
    });
  });

  // Measured on curl 8.7.1 and Bun 1.3.14, not recalled: with both spellings set to different
  // proxies, both tools take the LOWERCASE one — and curl ignores a bare `HTTP_PROXY` entirely.
  // An operator who copies a working pair off a host must get the same answer here.
  test("the lowercase spelling wins when a host sets both, matching curl and Bun", () => {
    expect(
      networkFrom({}, { HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:2" }),
    ).toEqual({ httpsProxy: "http://lower:2" });
  });

  test("blank and whitespace-only values are absent, not an empty proxy", () => {
    expect(networkFrom({ HTTPS_PROXY: "   ", LAZYIT_CA_FILE: "" }, {})).toEqual({});
  });
});

describe("noProxyMatches — the bypass list, as curl and Bun read it", () => {
  test("no list at all never bypasses", () => {
    expect(noProxyMatches(undefined, "lazyit.corp", "")).toBe(false);
    expect(noProxyMatches("", "lazyit.corp", "")).toBe(false);
  });

  test("a bare `*` bypasses everything", () => {
    expect(noProxyMatches("*", "anything.example.com", "443")).toBe(true);
  });

  test("an exact hostname matches, case-insensitively", () => {
    expect(noProxyMatches("lazyit.corp", "LAZYIT.corp", "")).toBe(true);
    expect(noProxyMatches("lazyit.corp", "other.corp", "")).toBe(false);
  });

  test("a leading dot is a suffix rule and does NOT match the bare domain", () => {
    expect(noProxyMatches(".internal", "lazyit.internal", "")).toBe(true);
    expect(noProxyMatches(".internal", "internal", "")).toBe(false);
  });

  test("a dotless entry still matches subdomains, which is what operators expect", () => {
    expect(noProxyMatches("internal", "lazyit.internal", "")).toBe(true);
  });

  test("a suffix rule never matches a host that merely ENDS with the letters", () => {
    expect(noProxyMatches("corp", "notcorp", "")).toBe(false);
    expect(noProxyMatches(".corp", "notcorp", "")).toBe(false);
  });

  test("an entry carrying a port matches only that port", () => {
    expect(noProxyMatches("lazyit.corp:8443", "lazyit.corp", "8443")).toBe(true);
    expect(noProxyMatches("lazyit.corp:8443", "lazyit.corp", "443")).toBe(false);
  });

  test("entries split on commas AND whitespace, blanks ignored", () => {
    expect(noProxyMatches(" a.corp , , b.corp\tc.corp ", "b.corp", "")).toBe(true);
    expect(noProxyMatches(" a.corp , , b.corp\tc.corp ", "c.corp", "")).toBe(true);
    expect(noProxyMatches(" a.corp , , b.corp\tc.corp ", "d.corp", "")).toBe(false);
  });
});

describe("proxyForUrl — one origin, one decision", () => {
  const net = { httpsProxy: "http://proxy.corp:3128", httpProxy: "http://plain.corp:3128" };

  test("an https target takes HTTPS_PROXY", () => {
    expect(proxyForUrl(net, "https://lazyit.corp/api/infra/report")).toBe(
      "http://proxy.corp:3128",
    );
  });

  test("an http target takes HTTP_PROXY", () => {
    expect(proxyForUrl(net, "http://lazyit.corp/api/infra/report")).toBe(
      "http://plain.corp:3128",
    );
  });

  test("HTTPS_PROXY alone does NOT proxy a plain-http target", () => {
    expect(proxyForUrl({ httpsProxy: "http://p:1" }, "http://lazyit.corp/")).toBeUndefined();
  });

  test("a NO_PROXY hit means a direct connection — the usual internal-instance case", () => {
    expect(
      proxyForUrl({ ...net, noProxy: ".corp" }, "https://lazyit.corp/api/infra/report"),
    ).toBeUndefined();
  });

  test("NO_PROXY compares the URL's port, defaulting to the scheme's", () => {
    expect(proxyForUrl({ ...net, noProxy: "lazyit.corp:443" }, "https://lazyit.corp/")).toBeUndefined();
    expect(proxyForUrl({ ...net, noProxy: "lazyit.corp:443" }, "https://lazyit.corp:8443/")).toBe(
      "http://proxy.corp:3128",
    );
  });

  test("no proxy configured at all is a direct connection", () => {
    expect(proxyForUrl({}, "https://lazyit.corp/")).toBeUndefined();
  });

  test("an unparseable URL never throws — the caller reports a reachability error instead", () => {
    expect(proxyForUrl(net, "not a url")).toBeUndefined();
  });
});

describe("agentFetchInit — what actually rides on every request", () => {
  test("nothing configured produces no proxy and no tls override", () => {
    expect(agentFetchInit({}, "https://lazyit.corp/")).toEqual({});
  });

  test("a resolved proxy is passed EXPLICITLY, never left to ambient env capture", () => {
    expect(
      agentFetchInit({ httpsProxy: "http://proxy.corp:3128" }, "https://lazyit.corp/"),
    ).toEqual({ proxy: "http://proxy.corp:3128" });
  });

  test("a CA file becomes a tls trust anchor for the request", () => {
    const init = agentFetchInit({ caFile: "/etc/pki/corp-root.pem" }, "https://lazyit.corp/");
    expect(init.proxy).toBeUndefined();
    expect(init.tls?.ca).toBeDefined();
  });
});

describe("disableAmbientProxy — the agent's own resolution is the WHOLE decision (#1137)", () => {
  test("a proxy variable present in the environment is blanked, not deleted", () => {
    // Measured on Bun 1.3.14: `delete process.env.HTTP_PROXY` does NOT stop Bun proxying a fetch,
    // while assigning "" does. The distinction is load-bearing, so it is pinned here.
    const env: Record<string, string | undefined> = {
      HTTPS_PROXY: "http://ambient:3128",
      no_proxy: "lazyit.corp",
      PATH: "/usr/bin",
    };
    disableAmbientProxy(env);
    expect(env.HTTPS_PROXY).toBe("");
    expect(env.no_proxy).toBe("");
    expect("HTTPS_PROXY" in env).toBe(true);
    expect(env.PATH).toBe("/usr/bin");
  });

  test("a variable the host never set is left absent rather than added as empty", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    disableAmbientProxy(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("every spelling Bun reads is covered, in both cases", () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: "a",
      http_proxy: "b",
      HTTPS_PROXY: "c",
      https_proxy: "d",
      NO_PROXY: "e",
      no_proxy: "f",
    };
    disableAmbientProxy(env);
    expect(Object.values(env)).toEqual(["", "", "", "", "", ""]);
  });
});

describe("interpretGuardProbe — proving the origin is lazyit before trusting its answer", () => {
  test.each([401, 403])(
    "%d to an UNAUTHENTICATED request is the proof: something is gating this route",
    (status) => {
      const verdict = interpretGuardProbe(status, "Unauthorized");
      expect(verdict.ok).toBe(true);
    },
  );

  // The whole point of the pre-probe: a 404 from a random origin is exactly what an unguarded web
  // server answers, and it is indistinguishable from lazyit's "no binary for that arch" 404.
  test("404 to an unauthenticated request means nothing evaluated a token", () => {
    const verdict = interpretGuardProbe(404, "Not Found");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/--url|\/api/);
  });

  test("200 to an unauthenticated request means the route is not gated at all", () => {
    const verdict = interpretGuardProbe(200, "OK");
    expect(verdict.ok).toBe(false);
  });

  test("a 3xx is still the wrong-origin diagnosis", () => {
    const verdict = interpretGuardProbe(302, "Found");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/:3000|reverse proxy/);
  });
});

describe("interpretProbe — `lazyit-agent test` reading the instance's answer (#1137)", () => {
  /** What a real lazyit instance answers the token-less pre-probe. */
  const guarded = { status: 401, statusText: "Unauthorized" };

  test("200 is the plain pass", () => {
    expect(interpretProbe(guarded, { status: 200, statusText: "OK" }, "x64")).toEqual({
      ok: true,
      note: "reached and authenticated",
    });
  });

  // The probe rides GET /agent/download, which is gated on infra:report and 404s when the image
  // bundles no binary for that arch. The guard runs FIRST, so a 404 proves the token was accepted —
  // reporting it as a failure would send an operator hunting a token that is perfectly fine. What
  // makes that reading SOUND is the token-less pre-probe: 401 without the token, 404 with it, so the
  // answer changed BECAUSE of the credential.
  test("404 is a PASS once the token-less probe proved the route is gated", () => {
    const verdict = interpretProbe(guarded, { status: 404, statusText: "Not Found" }, "arm64");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.note).toContain("arm64");
    expect(verdict.ok && verdict.note).toMatch(/authenticated/);
  });

  // THE REGRESSION THIS PAIR EXISTS FOR: point `--url` at any origin that 404s everything and the
  // command whose entire job is catching a wrong URL used to print PASS.
  test("404 from an origin that also 404s WITHOUT a token is a FAIL, not a pass", () => {
    const verdict = interpretProbe(
      { status: 404, statusText: "Not Found" },
      { status: 404, statusText: "Not Found" },
      "x64",
    );
    expect(verdict.ok).toBe(false);
  });

  test("200 from an origin that answers 200 to everything is a FAIL too", () => {
    const verdict = interpretProbe(
      { status: 200, statusText: "OK" },
      { status: 200, statusText: "OK" },
      "x64",
    );
    expect(verdict.ok).toBe(false);
  });

  test.each([401, 403])("%d is a token failure, named as one", (status) => {
    const verdict = interpretProbe(guarded, { status, statusText: "Unauthorized" }, "x64");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/infra:report/);
  });

  test("a 3xx is the wrong-origin diagnosis, not a token one", () => {
    const verdict = interpretProbe(guarded, { status: 302, statusText: "Found" }, "x64");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/:3000|reverse proxy/);
    expect(verdict.ok === false && verdict.detail).not.toMatch(/token/);
  });

  // InfraReportRateLimitGuard is applied to POST /infra/report alone, so it cannot produce a 429
  // here — attributing one to it would send an operator to raise a setting that was never involved.
  test("429 is a rate limit in front, and is NOT blamed on lazyit's report limit", () => {
    const verdict = interpretProbe(guarded, { status: 429, statusText: "Too Many Requests" }, "x64");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.headline).toContain("429");
    expect(verdict.ok === false && verdict.detail).not.toMatch(/token is wrong/);
    expect(verdict.ok === false && verdict.detail).not.toMatch(/INFRA_REPORT_MAX/);
    expect(verdict.ok === false && verdict.detail).toMatch(/proxy|WAF/);
  });

  test("a 500 is the instance's problem, and says so", () => {
    const verdict = interpretProbe(
      guarded,
      { status: 500, statusText: "Internal Server Error" },
      "x64",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/logs/);
  });
});
