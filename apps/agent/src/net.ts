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
 *    runtime — which is only true if the runtime is actually taken out of the decision, and that is
 *    what {@link disableAmbientProxy} is for.
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
 * install can set them without a file. The **lowercase** spelling wins over the UPPERCASE one when a
 * host sets both — measured on curl 8.7.1 and Bun 1.3.14 rather than recalled: both take the
 * lowercase value, and curl ignores a bare `HTTP_PROXY` outright. An operator who copies a working
 * pair off a host has to get the same answer here as the tools they copied it from.
 */
export function networkFrom(
  file: Record<string, string>,
  env: Record<string, string | undefined>,
): AgentNetwork {
  const pick = (key: string): string | undefined =>
    value(env[key.toLowerCase()]) ?? value(env[key]) ?? value(file[key.toLowerCase()]) ?? value(file[key]);
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
 *
 * An OMITTED `proxy` means a direct connection, and it only means that because
 * {@link disableAmbientProxy} has already run: Bun otherwise falls back to the process environment
 * whenever the option is absent, so a `NO_PROXY` in the config file would lose to an `HTTPS_PROXY`
 * in the environment and `test` would print the opposite of what the report is about to do.
 */
export function agentFetchInit(net: AgentNetwork, url: string): AgentFetchInit {
  const proxy = proxyForUrl(net, url);
  return {
    ...(proxy ? { proxy } : {}),
    ...(net.caFile ? { tls: { ca: [Bun.file(net.caFile)] } } : {}),
  };
}

/** Every spelling Bun reads a proxy decision out of. Both cases, because Bun reads both. */
const AMBIENT_PROXY_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/**
 * Hand the whole proxy decision to {@link agentFetchInit} by silencing the ambient environment.
 *
 * Called once, right after the config is resolved and before the first request. By then every one of
 * these variables has already been read into {@link AgentNetwork} (the environment WINS over the
 * config file, per key), so nothing is lost — what is removed is Bun's second, independent opinion,
 * which is otherwise consulted in exactly the two places it must not be:
 *
 *  - **An omitted `proxy` option is not a direct connection.** Bun falls back to the environment,
 *    so a `NO_PROXY` written in `/etc/lazyit-agent/config` could not stop an `HTTPS_PROXY` the unit
 *    inherited — and `test` would cheerfully print "bypassed for this host (NO_PROXY)" about a
 *    request that went through the proxy anyway.
 *  - **An ambient `NO_PROXY` overrides even an EXPLICIT `proxy` option.** Measured, not assumed: with
 *    `NO_PROXY=*` in the environment, Bun 1.3.14 ignores `fetch(url, { proxy })` and connects
 *    directly. A host-wide bypass list would therefore silently defeat the config file's proxy.
 *
 * BLANKED, NOT DELETED, and that is not a style choice: on Bun 1.3.14 `delete process.env.HTTP_PROXY`
 * leaves the proxy in force, while assigning `""` reads as "no proxy". A key the host never set is
 * left absent rather than added as an empty string, so the environment inherited by `dmidecode`,
 * `dpkg-query` and the rest is the one the host actually has.
 */
export function disableAmbientProxy(env: Record<string, string | undefined>): void {
  for (const key of AMBIENT_PROXY_KEYS) {
    if (env[key] !== undefined) env[key] = "";
  }
}

/** What `lazyit-agent test` concluded from one probe: a pass with a note, or a named failure. */
export type ProbeVerdict =
  | { ok: true; note: string }
  | { ok: false; headline: string; detail: string };

/** One HTTP answer, as `lazyit-agent test` received it. */
export interface ProbeAnswer {
  status: number;
  statusText: string;
}

/**
 * The TOKEN-LESS pre-probe: the same `HEAD` on `GET /agent/download`, sent with no `authorization`
 * header at all. It exists to make the answer that follows mean something.
 *
 * `GET /agent/download` is gated on `infra:report`, so a lazyit instance answers an anonymous request
 * with **401**, from the guard, before the handler runs. Anything else did not reach that guard:
 *
 *  - **404** is what any ordinary web server, S3 bucket or reverse proxy that does not route `/api`
 *    answers, and it is byte-for-byte indistinguishable from lazyit's own "this image bundles no
 *    binary for that arch" 404. Without this probe, `lazyit-agent test` pointed at the wrong origin
 *    entirely reported PASS — which is the exact misconfiguration the command exists to catch.
 *  - **2xx** means whatever is at that URL serves it to anyone, so no credential was evaluated.
 *  - **3xx** is the wrong origin (#980), the same diagnosis as with a token.
 *
 * A front door that demands its own basic auth also answers 401 here — which is why the pair is what
 * proves anything: this probe establishes that the route is gated, and {@link interpretProbe} then
 * requires the answer to CHANGE once the Service Account token is attached. A front door that rejects
 * both requests can therefore never produce a pass, which is the property that matters. It is not
 * told apart from a bad token, though: the printed diagnosis names the Service Account, and in that
 * one case the real cause is a layer in front. Distinguishing them needs something identifying in the
 * answer, and a `HEAD` gives no body to read it out of.
 */
export function interpretGuardProbe(status: number, statusText: string): ProbeVerdict {
  if (status === 401 || status === 403) {
    return {
      ok: true,
      note: "the route is token-gated, so this origin is a lazyit instance and the token will be evaluated",
    };
  }
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      headline: `the URL redirected (${status})`,
      detail:
        "--url is not the HTTPS origin in front of your reverse proxy — the raw web port :3000 has no /api route and sends you to /login",
    };
  }
  if (status === 429) {
    return {
      ok: false,
      headline: `the URL answered 429 ${statusText}`,
      detail:
        "something in front of the instance is rate limiting this request (a reverse proxy or WAF — lazyit's own report limit does not cover this route). The credential is fine; wait, then try again",
    };
  }
  return {
    ok: false,
    headline: `the URL answered ${status} ${statusText} to a request carrying NO token`,
    detail:
      "a lazyit instance answers 401 there, from the permission guard, before anything else runs — so this request never reached lazyit. Check --url, and that your reverse proxy routes /api to the instance",
  };
}

/**
 * Read the instance's answers to `lazyit-agent test`'s probe — two `HEAD`s on `GET /agent/download`,
 * one anonymous and one carrying the Service Account token. The route is gated on the same
 * `infra:report` permission the report endpoint is and writes nothing, either time.
 *
 * **The pair is the proof, and a single answer is not.** `interpretGuardProbe` establishes that the
 * route is token-gated; only then does an authenticated answer say anything about the credential,
 * because only then did the answer change *because of* the token.
 *
 * Every branch below exists because it is a DIFFERENT thing to go fix, and the point of the command
 * is that an operator stops guessing which:
 *
 *  - **404 is a PASS**, but only behind the pre-probe. The permission guard runs before the handler,
 *    so 401-without-the-token then 404-with-it means the token was accepted and only then did the
 *    route say this image bundles no binary for that arch. Calling that a failure would send someone
 *    off to re-mint a token that works perfectly; calling a bare 404 a pass reported success for a
 *    URL that never touched lazyit.
 *  - **3xx is the wrong origin**, never the token — `--url` pointing at the raw web port instead of
 *    the HTTPS front is the single most common install mistake (#980), and it authenticates nothing.
 *  - **429 is a rate limit somewhere in front**, not a bad credential. It is deliberately NOT
 *    attributed to the per-service-account report limit (#1134): that guard is scoped to
 *    `POST /infra/report` and cannot fire here, so a 429 on this route came from a reverse proxy or
 *    a WAF between the host and the instance. Naming the wrong limiter would send an operator to
 *    raise a setting that was never involved.
 */
export function interpretProbe(
  unauthenticated: ProbeAnswer,
  authenticated: ProbeAnswer,
  arch: string,
): ProbeVerdict {
  const guard = interpretGuardProbe(unauthenticated.status, unauthenticated.statusText);
  if (!guard.ok) return guard;

  const { status, statusText } = authenticated;
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
