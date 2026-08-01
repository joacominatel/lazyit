/**
 * How the agent gets OUT of the host: an egress proxy and a private certificate authority
 * (ADR-0074 §7 amendment, issue #1137).
 *
 * Both are the norm in the segment lazyit targets and neither was reachable before. A systemd unit
 * starts with an almost-empty environment, so a host-wide `HTTPS_PROXY` in `/etc/environment` or a
 * shell profile simply is not there when the timer fires — the agent would work by hand and fail on
 * the tick, which is the worst shape a networking bug can take. And an instance behind a LAN
 * self-signed certificate had exactly one documented answer: trust that CA **system-wide**, which is
 * a far larger grant than "one inventory agent talks to one host".
 *
 * So both settings are read from the agent's own `/etc/lazyit-agent/config` (env still wins, per key)
 * and applied EXPLICITLY on each request:
 *
 *  - `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` — resolved here and passed as fetch's `proxy` option
 *    rather than left to Bun's ambient environment handling. Bun does honour those variables on its
 *    own, but only from the process environment, which is precisely what the unit does not have; and
 *    a `NO_PROXY` that lives in the config file is invisible to it. Resolving both from one source
 *    keeps the two halves of the decision in the same place instead of half here and half in the
 *    runtime.
 *  - `LAZYIT_CA_FILE` — a PEM bundle the agent trusts for its own HTTPS requests, and only its own.
 *    Point it at a bundle containing everything the agent has to trust to reach your instance (your
 *    internal root, and your proxy's if it terminates TLS).
 *
 * Neither is a policy field and neither ever will be. Both name a local file or a local egress path,
 * which is exactly the class of thing §7's second hard rule keeps the server from being able to say.
 */

/** The four settings, already resolved from environment-then-file. Every field is optional. */
export interface AgentNetwork {
  httpsProxy?: string;
  httpProxy?: string;
  noProxy?: string;
  /** Path to a PEM bundle the agent trusts for its HTTPS requests. */
  caFile?: string;
}

/** What rides on a request: fetch's Bun-specific `proxy` and `tls` options, or nothing at all. */
export interface AgentFetchInit {
  proxy?: string;
  tls?: { ca: ReturnType<typeof Bun.file>[] };
}

/** A trimmed non-empty value, or undefined — a blank `HTTPS_PROXY=` must read as "no proxy". */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the four settings from the config file and the environment, key by key.
 *
 * Environment wins, matching every other setting the agent has, so a container or an image-baked
 * install can set them without a file. The UPPERCASE spelling wins over the lowercase one when a
 * host sets both, which is what curl does and therefore what an operator predicts.
 */
export function networkFrom(
  file: Record<string, string>,
  env: Record<string, string | undefined>,
): AgentNetwork {
  const pick = (key: string): string | undefined =>
    value(env[key]) ?? value(env[key.toLowerCase()]) ?? value(file[key]) ?? value(file[key.toLowerCase()]);
  const httpsProxy = pick("HTTPS_PROXY");
  const httpProxy = pick("HTTP_PROXY");
  const noProxy = pick("NO_PROXY");
  const caFile = pick("LAZYIT_CA_FILE");
  return {
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(httpProxy ? { httpProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
    ...(caFile ? { caFile } : {}),
  };
}

/**
 * The de-facto `NO_PROXY` reading, kept deliberately boring: split on commas and whitespace, `*`
 * bypasses everything, an entry may carry `:port`, and a leading dot means "subdomains only".
 *
 * A dotless entry still covers subdomains (`internal` bypasses `lazyit.internal`) because that is
 * what curl, Go and Bun all do and an operator copying a working `NO_PROXY` from one of them must
 * not get a different answer here. What no reading of it does is match on a bare suffix of
 * characters: `corp` never bypasses `notcorp`, which is the mistake a naive `endsWith` makes.
 *
 * IPv6 literals and CIDR entries are NOT supported. They are rare in a `NO_PROXY` and a wrong answer
 * would be worse than no answer; an operator with either can name the host instead.
 */
export function noProxyMatches(
  noProxy: string | undefined,
  hostname: string,
  port: string,
): boolean {
  const list = noProxy?.trim();
  if (!list) return false;
  const host = hostname.toLowerCase();
  for (const raw of list.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    // Split a trailing `:port` off. `lastIndexOf` rather than `indexOf` so a stray colon earlier in
    // the entry cannot swallow the port; an entry with no colon keeps its whole self as the host.
    const colon = entry.lastIndexOf(":");
    const entryHost = colon === -1 ? entry : entry.slice(0, colon);
    const entryPort = colon === -1 ? "" : entry.slice(colon + 1);
    if (entryPort && entryPort !== port) continue;
    if (!entryHost) continue;
    const hit = entryHost.startsWith(".")
      ? host.endsWith(entryHost)
      : host === entryHost || host.endsWith(`.${entryHost}`);
    if (hit) return true;
  }
  return false;
}

/**
 * The proxy for one URL, or undefined for a direct connection.
 *
 * `HTTPS_PROXY` covers https targets and `HTTP_PROXY` http ones — they are not interchangeable, and
 * a host that sets only `HTTPS_PROXY` must reach a plain-http instance directly rather than through
 * a proxy it never named for that scheme.
 *
 * An unparseable URL yields undefined rather than throwing: the caller is about to fail on that URL
 * anyway, and it will say so far more usefully than a TypeError from the proxy resolver would.
 */
export function proxyForUrl(net: AgentNetwork, url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const https = parsed.protocol === "https:";
  const proxy = https ? net.httpsProxy : net.httpProxy;
  if (!proxy) return undefined;
  const port = parsed.port || (https ? "443" : "80");
  return noProxyMatches(net.noProxy, parsed.hostname, port) ? undefined : proxy;
}

/**
 * The Bun-specific fetch options for one request. Spread onto every call the agent makes, so the
 * proxy and the CA apply identically to the report POST and to the `test` reachability probe — an
 * agent whose diagnostic took a different route to its report would diagnose the wrong network.
 */
export function agentFetchInit(net: AgentNetwork, url: string): AgentFetchInit {
  const proxy = proxyForUrl(net, url);
  return {
    ...(proxy ? { proxy } : {}),
    ...(net.caFile ? { tls: { ca: [Bun.file(net.caFile)] } } : {}),
  };
}

/** What `lazyit-agent test` concluded from one probe: a pass with a note, or a named failure. */
export type ProbeVerdict =
  | { ok: true; note: string }
  | { ok: false; headline: string; detail: string };

/**
 * Read the instance's answer to `lazyit-agent test`'s probe — a `HEAD` on `GET /agent/download`,
 * which is gated on the same `infra:report` permission the report endpoint is and writes nothing.
 *
 * Every branch here exists because it is a DIFFERENT thing to go fix, and the point of the command
 * is that an operator stops guessing which:
 *
 *  - **404 is a PASS.** The permission guard runs before the handler, so a 404 means the token was
 *    accepted and only then did the route say this image bundles no binary for that arch. Calling it
 *    a failure would send someone off to re-mint a token that works perfectly.
 *  - **3xx is the wrong origin**, never the token — `--url` pointing at the raw web port instead of
 *    the HTTPS front is the single most common install mistake (#980), and it authenticates nothing.
 *  - **429 is a rate limit somewhere in front**, not a bad credential. It is deliberately NOT
 *    attributed to the per-service-account report limit (#1134): that guard is scoped to
 *    `POST /infra/report` and cannot fire here, so a 429 on this route came from a reverse proxy or
 *    a WAF between the host and the instance. Naming the wrong limiter would send an operator to
 *    raise a setting that was never involved.
 */
export function interpretProbe(status: number, statusText: string, arch: string): ProbeVerdict {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      headline: `reached the instance, but it rejected the token (${status})`,
      detail:
        "the Service Account is wrong, revoked, or does not hold infra:report — mint a new agent in lazyit (Assets → Topology → Add agent)",
    };
  }
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      headline: `the instance redirected (${status})`,
      detail:
        "--url is not the HTTPS origin in front of your reverse proxy — the raw web port :3000 has no /api route and sends you to /login",
    };
  }
  if (status === 429) {
    return {
      ok: false,
      headline: `the instance answered 429 ${statusText}`,
      detail:
        "something in front of the instance is rate limiting this request (a reverse proxy or WAF — lazyit's own report limit does not cover this route). The credential is fine; wait, then try again",
    };
  }
  if (status === 404) {
    return {
      ok: true,
      note: `reached and authenticated — this build bundles no ${arch} binary, which does not affect reporting`,
    };
  }
  if (status >= 400) {
    return {
      ok: false,
      headline: `the instance answered ${status} ${statusText}`,
      detail: "it is reachable but unhealthy — check its logs",
    };
  }
  return { ok: true, note: "reached and authenticated" };
}
