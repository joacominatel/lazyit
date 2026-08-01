import { describe, expect, test } from "bun:test";
import {
  agentFetchInit,
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

  test("the UPPERCASE spelling wins when a host sets both, matching curl", () => {
    expect(
      networkFrom({}, { HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:2" }),
    ).toEqual({ httpsProxy: "http://upper:1" });
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

describe("interpretProbe — `lazyit-agent test` reading the instance's answer (#1137)", () => {
  test("200 is the plain pass", () => {
    expect(interpretProbe(200, "OK", "x64")).toEqual({
      ok: true,
      note: "reached and authenticated",
    });
  });

  // The probe rides GET /agent/download, which is gated on infra:report and 404s when the image
  // bundles no binary for that arch. The guard runs FIRST, so a 404 proves the token was accepted —
  // reporting it as a failure would send an operator hunting a token that is perfectly fine.
  test("404 is a PASS, and says why it is not a token problem", () => {
    const verdict = interpretProbe(404, "Not Found", "arm64");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.note).toContain("arm64");
    expect(verdict.ok && verdict.note).toMatch(/authenticated/);
  });

  test.each([401, 403])("%d is a token failure, named as one", (status) => {
    const verdict = interpretProbe(status, "Unauthorized", "x64");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/infra:report/);
  });

  test("a 3xx is the wrong-origin diagnosis, not a token one", () => {
    const verdict = interpretProbe(302, "Found", "x64");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/:3000|reverse proxy/);
    expect(verdict.ok === false && verdict.detail).not.toMatch(/token/);
  });

  // InfraReportRateLimitGuard is applied to POST /infra/report alone, so it cannot produce a 429
  // here — attributing one to it would send an operator to raise a setting that was never involved.
  test("429 is a rate limit in front, and is NOT blamed on lazyit's report limit", () => {
    const verdict = interpretProbe(429, "Too Many Requests", "x64");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.headline).toContain("429");
    expect(verdict.ok === false && verdict.detail).not.toMatch(/token is wrong/);
    expect(verdict.ok === false && verdict.detail).not.toMatch(/INFRA_REPORT_MAX/);
    expect(verdict.ok === false && verdict.detail).toMatch(/proxy|WAF/);
  });

  test("a 500 is the instance's problem, and says so", () => {
    const verdict = interpretProbe(500, "Internal Server Error", "x64");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.detail).toMatch(/logs/);
  });
});
