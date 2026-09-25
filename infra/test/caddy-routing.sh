#!/bin/sh
# =============================================================================
# caddy-routing.sh — regression test for the lazyit reverse proxy (issues #1250, #1322, #1315).
#
# Two parts, both against the REAL Caddyfile and the digest-pinned image from compose.yaml (the exact
# Caddy production runs):
#
# 1. Static routing (`caddy adapt`, once per network/TLS mode — local, real, lan; ADR-0087).
#    Asserts first-match routing for a request-path corpus, the path the upstream receives, and which
#    requests skip `encode`:
#    - the API's local-auth password endpoints under /api/auth/* (ADR-0086 §F4b) reach the API, while
#      Auth.js's own action paths (ADR-0039) reach the web app (#1250 — a broad `not path /api/auth/*`
#      once sent change-password & co. to Auth.js, which 400s "Bad request.");
#    - the external-agent paths (/mcp, OAuth metadata and protocol endpoints — ADR-0097) reach the
#      API WITHOUT the /api strip, while /oauth/authorize (the consent page) stays on the web app;
#    - the paths MCP SDK clients probe when the RFC 8414 metadata is missing — OIDC discovery and the
#      root fallbacks /authorize, /token, /register — reach the API (its JSON 404), not the web's
#      /login HTML (#1315, W4-3 finding F1);
#    - streamed requests (the run event stream, /mcp, `Accept: text/event-stream`) are not wrapped
#      by `encode`, and ordinary requests still are.
#
# 2. Live SSE streaming (#1322). Runs the pinned Caddy in `lan` mode in front of a scripted upstream
#    (busybox `nc` in the same pinned image — no other image is pulled) that sends the SSE response
#    header, then one event every 2 s. Asserts, through the real proxy, that the header arrives before
#    the first event (the pinned v2.11.3 `encode` withholds it otherwise — caddyserver/caddy#6293),
#    that events arrive incrementally and uncompressed, and that an ordinary large response is still
#    compressed. It also checks, end to end, which upstream answers the new paths and the path it saw.
#
# Requires docker + python3. No build artifacts, no host ports other than one ephemeral loopback port.
#
# Run from anywhere:  sh infra/test/caddy-routing.sh
# Exit 0 = routing and streaming as intended; non-zero = a regression.
# =============================================================================
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)

PIN=$(grep -o 'caddy:2-alpine@sha256:[0-9a-f]*' "$REPO_ROOT/compose.yaml" | head -n1)
if [ -z "$PIN" ]; then
  echo "ERROR: could not extract the pinned caddy image from compose.yaml" >&2
  exit 1
fi

WORK=$(mktemp -d)
RUN_ID="lazyit-caddy-test-$$"
cleanup() {
  docker rm -f "$RUN_ID-caddy" "$RUN_ID-upstream" >/dev/null 2>&1 || true
  docker network rm "$RUN_ID" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
# Part 1 — static routing, per network/TLS mode.
# -----------------------------------------------------------------------------
for SITE in localhost lazyit.example.com :80; do
  ADAPT_FILE="$WORK/adapt.json"
  docker run --rm -e LAZYIT_SITE_ADDRESS="$SITE" -v "$REPO_ROOT/infra/caddy:/etc/caddy:ro" "$PIN" \
    caddy adapt --config /etc/caddy/Caddyfile --pretty 2>/dev/null > "$ADAPT_FILE" || {
    echo "ERROR: caddy adapt failed on infra/caddy/Caddyfile (LAZYIT_SITE_ADDRESS=$SITE)" >&2
    exit 1
  }

  echo "== static routing — LAZYIT_SITE_ADDRESS=$SITE"
  python3 - "$ADAPT_FILE" "$SITE" <<'PYEOF'
import fnmatch
import json
import sys

ADAPT_FILE, SITE = sys.argv[1], sys.argv[2]

# (request path, expected upstream host, path the upstream receives — None = not checked).
CORPUS = [
    # API local-auth password endpoints (issue #1250) MUST reach the API:
    ("/api/auth/change-password", "api", "/auth/change-password"),
    ("/api/auth/forgot-password", "api", "/auth/forgot-password"),
    ("/api/auth/reset-password", "api", "/auth/reset-password"),
    ("/api/auth/login", "api", "/auth/login"),  # server-side today, but never Auth.js
    ("/api/users", "api", "/users"),            # generic API routes, /api stripped
    ("/api/assets", "api", "/assets"),
    ("/api/health/ready", "api", "/health/ready"),
    ("/api/ai/runs/abc123/events", "api", "/ai/runs/abc123/events"),  # the run event stream (SSE)
    # Auth.js action paths (ADR-0039) MUST reach the web app:
    ("/api/auth/session", "web", None),
    ("/api/auth/csrf", "web", None),
    ("/api/auth/providers", "web", None),
    ("/api/auth/signin", "web", None),
    ("/api/auth/signin/credentials", "web", None),
    ("/api/auth/callback/credentials", "web", None),
    ("/api/auth/signout", "web", None),
    ("/api/auth/verify-request", "web", None),
    ("/api/auth/error", "web", None),
    ("/api/auth/webauthn-options", "web", None),
    # External-agent paths (ADR-0097) reach the API UNSTRIPPED:
    ("/mcp", "api", "/mcp"),
    ("/.well-known/oauth-protected-resource", "api", "/.well-known/oauth-protected-resource"),
    ("/.well-known/oauth-protected-resource/mcp", "api", "/.well-known/oauth-protected-resource/mcp"),
    ("/.well-known/oauth-authorization-server", "api", "/.well-known/oauth-authorization-server"),
    ("/oauth/token", "api", "/oauth/token"),
    ("/oauth/register", "api", "/oauth/register"),
    ("/oauth/revoke", "api", "/oauth/revoke"),
    # What MCP SDK clients probe when RFC 8414 metadata is missing (#1315, W4-3 F1): OIDC discovery
    # and the root OAuth fallbacks reach the API — which answers JSON 404 — never the web's /login HTML.
    ("/.well-known/openid-configuration", "api", "/.well-known/openid-configuration"),
    ("/.well-known/openid-configuration/mcp", "api", "/.well-known/openid-configuration/mcp"),
    ("/authorize", "api", "/authorize"),
    ("/token", "api", "/token"),
    ("/register", "api", "/register"),
    # ...and nothing wider: the consent page and any other /oauth or /.well-known path stay on web.
    ("/oauth/authorize", "web", None),
    ("/oauth/other", "web", None),
    ("/mcp/extra", "web", None),
    ("/.well-known/security.txt", "web", None),
    ("/authorize/extra", "web", None),
    ("/registration", "web", None),
    ("/tokens", "web", None),
    # Web UI — everything else falls to the catch-all:
    ("/", "web", None),
    ("/login", "web", None),
    ("/assets/logo.svg", "web", None),
]

# (request path, request headers, expected: wrapped by `encode`?)
SSE = "text/event-stream"
ENCODE_CORPUS = [
    ("/api/ai/runs/abc123/events", {}, False),
    ("/api/ai/runs/abc123/events", {"Accept": SSE}, False),
    ("/mcp", {"Accept": "application/json, " + SSE}, False),
    ("/mcp", {}, False),
    ("/api/some/future/stream", {"Accept": SSE}, False),
    ("/api/users", {"Accept": "application/json"}, True),
    ("/api/ai/runs/abc123", {}, True),
    ("/", {"Accept": "text/html"}, True),
    ("/.well-known/oauth-authorization-server", {}, True),
]


def glob_match(pattern, value):
    # Caddy `path` / `header` value glob: '*' matches any run of characters. (Caddy's middle-'*' in a
    # path does not cross '/'; no corpus entry depends on that difference.)
    return fnmatch.fnmatchcase(value, pattern)


def matcher_set_matches(ms, path, headers):
    # A Caddy matcher set dict: {path}, {header} and/or {not: [matcher_set, ...]}, AND'ed.
    if "path" in ms and not any(glob_match(p, path) for p in ms["path"]):
        return False
    for field, patterns in ms.get("header", {}).items():
        value = headers.get(field)
        if value is None or not any(glob_match(p, value) for p in patterns):
            return False
    for neg in ms.get("not", []):
        inner = neg if isinstance(neg, list) else [neg]
        if any(matcher_set_matches(n, path, headers) for n in inner):
            return False
    return True


def route_matches(route, path, headers=None):
    # route['match'] is a list of matcher sets (OR'd); absent means match everything.
    return any(matcher_set_matches(ms, path, headers or {}) for ms in route.get("match", [{}]))


def route_upstream(route, path):
    # Walk the route's handlers in order, applying prefix-strip rewrites, until a reverse_proxy.
    # Returns (upstream host, path it receives) or None.
    def walk(handlers, p):
        for h in handlers:
            kind = h.get("handler")
            if kind == "rewrite" and "strip_path_prefix" in h:
                prefix = h["strip_path_prefix"]
                if p.startswith(prefix):
                    p = p[len(prefix):] or "/"
            elif kind == "reverse_proxy":
                dial = h.get("upstreams", [{}])[0].get("dial", "")
                return dial.split(":")[0], p
            elif kind == "subroute":
                for sub in h.get("routes", []):
                    if route_matches(sub, p):
                        found = walk(sub.get("handle", []), p)
                        if found:
                            return found
        return None

    return walk(route.get("handle", []), path)


def main_site_routes(data):
    # local/real: the site block is a route with a host matcher for the site, wrapping a subroute.
    # lan (port-only address): no host matcher — the site's routes sit directly on the :80 server.
    for server in data["apps"]["http"]["servers"].values():
        if server.get("listen") == [":2021"]:
            continue  # the internal healthcheck listener
        for route in server.get("routes", []):
            for ms in route.get("match", []):
                if ms.get("host") == [SITE]:
                    for h in route.get("handle", []):
                        if h.get("handler") == "subroute":
                            return h.get("routes", [])
        if SITE.startswith(":") and server.get("listen") == [SITE]:
            return server.get("routes", [])
    raise SystemExit(f"ERROR: main site block ({SITE}) not found in adapted Caddy config")


def upstream_for(path, routes):
    # First match wins among the terminal `handle` routes; middleware routes carry no upstream.
    for route in routes:
        if route_matches(route, path):
            found = route_upstream(route, path)
            if found:
                return found
    return (None, None)


def encode_wraps(path, headers, routes):
    for route in routes:
        if any(h.get("handler") == "encode" for h in route.get("handle", [])):
            return route_matches(route, path, headers)
    raise SystemExit("ERROR: no encode route found in the site block")


data = json.load(open(ADAPT_FILE))
routes = main_site_routes(data)

fails = []
for path, want_host, want_path in CORPUS:
    host, got_path = upstream_for(path, routes)
    print(f"  {path:<44} -> {host or 'NO MATCH'} {got_path or ''}")
    if host != want_host:
        fails.append(f"{path}: expected upstream {want_host}, got {host}")
    elif want_path is not None and got_path != want_path:
        fails.append(f"{path}: expected the upstream to receive {want_path}, got {got_path}")

for path, headers, want in ENCODE_CORPUS:
    got = encode_wraps(path, headers, routes)
    if got != want:
        state = "wrapped by" if got else "NOT wrapped by"
        fails.append(f"{path} {headers}: {state} encode (expected the opposite)")

if fails:
    print("\nFAILED:")
    for f in fails:
        print(f"  {f}")
    sys.exit(1)
print(f"  OK — {len(CORPUS)} paths route as intended; {len(ENCODE_CORPUS)} encode decisions as intended")
PYEOF
done

# -----------------------------------------------------------------------------
# Part 2 — live SSE streaming through the pinned Caddy (lan mode, plain HTTP).
# -----------------------------------------------------------------------------
echo "== live streaming — pinned Caddy, LAZYIT_SITE_ADDRESS=:80"

# A one-exchange HTTP/1.1 upstream for `nc -e`: it reports who answered and the path it received, and
# streams SSE for event-stream paths. Sent without `Cache-Control: no-transform` on purpose, so the
# proxy config alone must keep the stream uncompressed. Plain responses are 2 KB — above encode's
# 512-byte minimum, so they are compressed when `encode` applies.
cat > "$WORK/upstream.sh" <<'SHEOF'
#!/bin/sh
read -r _method _path _proto
while IFS= read -r _h; do
  _h=$(printf '%s' "$_h" | tr -d '\r')
  [ -z "$_h" ] && break
done
case "$_path" in
  */events|/mcp|*/stream)
    printf 'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nX-Upstream: %s\r\nX-Upstream-Path: %s\r\nConnection: close\r\n\r\n' "$UPSTREAM_NAME" "$_path"
    sleep 2
    printf 'data: one %s\n\n' "$(head -c 900 /dev/zero | tr '\0' x)"
    sleep 2
    printf 'data: two\n\n'
    ;;
  *)
    printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Upstream: %s\r\nX-Upstream-Path: %s\r\nContent-Length: 2001\r\nConnection: close\r\n\r\n%s\n' "$UPSTREAM_NAME" "$_path" "$(head -c 2000 /dev/zero | tr '\0' x)"
    ;;
esac
SHEOF
UPSTREAM_SCRIPT=$(cat "$WORK/upstream.sh")

docker network create "$RUN_ID" >/dev/null
docker run -d --name "$RUN_ID-upstream" --network "$RUN_ID" \
  --network-alias api --network-alias web -e UPSTREAM_SCRIPT="$UPSTREAM_SCRIPT" \
  --entrypoint sh "$PIN" -c '
    printf "%s\n" "$UPSTREAM_SCRIPT" > /tmp/upstream.sh && chmod +x /tmp/upstream.sh
    UPSTREAM_NAME=web nc -lk -p 3000 -e /tmp/upstream.sh &
    UPSTREAM_NAME=api exec nc -lk -p 3001 -e /tmp/upstream.sh' >/dev/null
docker run -d --name "$RUN_ID-caddy" --network "$RUN_ID" -p 127.0.0.1::80 \
  -e LAZYIT_SITE_ADDRESS=:80 -v "$REPO_ROOT/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$PIN" >/dev/null

PORT=$(docker port "$RUN_ID-caddy" 80/tcp | head -n1 | sed 's/.*://')
if [ -z "$PORT" ]; then
  echo "ERROR: could not read the published Caddy port" >&2
  exit 1
fi

python3 - "$PORT" <<'PYEOF'
import socket
import sys
import time

PORT = int(sys.argv[1])


def exchange(method, path, headers):
    """Send one request; return (header_at, events, head, body) with times relative to the send."""
    lines = [f"{method} {path} HTTP/1.1", "Host: lazyit.test", "Connection: close"]
    lines += [f"{k}: {v}" for k, v in headers.items()]
    sock = socket.create_connection(("127.0.0.1", PORT), timeout=15)
    start = time.monotonic()
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    buf, header_at, events = b"", None, {}
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
        now = time.monotonic() - start
        if header_at is None and b"\r\n\r\n" in buf:
            header_at = now
        for marker in (b"data: one", b"data: two"):
            if marker not in events and marker in buf:
                events[marker] = now
    sock.close()
    head, _, body = buf.partition(b"\r\n\r\n")
    fields = {}
    for line in head.decode("latin-1").split("\r\n")[1:]:
        k, _, v = line.partition(":")
        fields[k.strip().lower()] = v.strip()
    return header_at, events, fields, body


# Wait for Caddy to serve (the catch-all answers from the web upstream).
deadline = time.monotonic() + 20
while True:
    try:
        _, _, fields, _ = exchange("GET", "/", {})
        if fields.get("x-upstream") == "web":
            break
    except OSError:
        pass
    if time.monotonic() > deadline:
        raise SystemExit("ERROR: Caddy did not come up within 20 s")
    time.sleep(0.5)

fails = []

# Streams: (label, path, request headers, expected upstream path).
ENC = {"Accept-Encoding": "gzip, zstd"}
STREAMS = [
    ("run event stream", "/api/ai/runs/abc123/events", dict(ENC), "/ai/runs/abc123/events"),
    ("MCP", "/mcp", dict(ENC, Accept="application/json, text/event-stream"), "/mcp"),
    ("Accept: event-stream", "/api/some/stream", dict(ENC, Accept="text/event-stream"), "/some/stream"),
]
for label, path, headers, want_path in STREAMS:
    header_at, events, fields, _ = exchange("GET", path, headers)
    one, two = events.get(b"data: one"), events.get(b"data: two")
    print(f"  {label:<22} header {header_at:.2f}s · one {one or -1:.2f}s · two {two or -1:.2f}s"
          f" · encoding {fields.get('content-encoding', 'none')} · upstream {fields.get('x-upstream')}"
          f" {fields.get('x-upstream-path')}")
    if fields.get("x-upstream") != "api" or fields.get("x-upstream-path") != want_path:
        fails.append(f"{label}: expected api {want_path}, got {fields.get('x-upstream')} {fields.get('x-upstream-path')}")
    if "content-encoding" in fields:
        fails.append(f"{label}: stream was compressed ({fields['content-encoding']})")
    if header_at is None or header_at >= 1.0:
        fails.append(f"{label}: response header arrived at {header_at}s — withheld until the first event")
    if one is None or two is None:
        fails.append(f"{label}: events not readable in the body (compressed or lost)")
    elif two - one < 1.0:
        fails.append(f"{label}: events arrived together ({one:.2f}s / {two:.2f}s) — the stream was buffered")

# Ordinary responses keep compression, and the new public paths reach the API unstripped.
_, _, fields, _ = exchange("GET", "/api/users", dict(ENC))
print(f"  {'ordinary 2 KB response':<22} encoding {fields.get('content-encoding', 'none')}"
      f" · upstream {fields.get('x-upstream')} {fields.get('x-upstream-path')}")
if fields.get("content-encoding") not in ("gzip", "zstd"):
    fails.append("ordinary response: expected encode to compress it")

for path, want in [
    ("/.well-known/oauth-authorization-server", ("api", "/.well-known/oauth-authorization-server")),
    ("/.well-known/oauth-protected-resource/mcp", ("api", "/.well-known/oauth-protected-resource/mcp")),
    ("/oauth/token", ("api", "/oauth/token")),
    ("/oauth/authorize", ("web", "/oauth/authorize")),
    ("/.well-known/openid-configuration", ("api", "/.well-known/openid-configuration")),
    ("/token", ("api", "/token")),
    ("/register", ("api", "/register")),
    ("/authorize", ("api", "/authorize")),
]:
    _, _, fields, _ = exchange("GET", path, {})
    got = (fields.get("x-upstream"), fields.get("x-upstream-path"))
    print(f"  {path:<44} -> {got[0]} {got[1]}")
    if got != want:
        fails.append(f"{path}: expected {want}, got {got}")

if fails:
    print("\nFAILED:")
    for f in fails:
        print(f"  {f}")
    sys.exit(1)
print("  OK — streams flush their header at once and arrive incrementally, uncompressed")
PYEOF
