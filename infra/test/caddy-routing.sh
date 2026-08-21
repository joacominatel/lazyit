#!/bin/sh
# =============================================================================
# caddy-routing.sh — routing regression test for the lazyit reverse proxy (issue #1250).
#
# Proves the non-trivial invariant: the API's local-auth password endpoints under /api/auth/*
# (ADR-0086 §F4b) reach the API container, while Auth.js's own action paths (/api/auth/*, ADR-0039)
# reach the web container. A broad `not path /api/auth/*` exclusion in the @api matcher previously
# sent change-password / forgot-password / reset-password to Auth.js, which 400s "Bad request." on
# the unknown action — see infra/caddy/Caddyfile for the current matcher.
#
# It runs `caddy adapt` on the REAL Caddyfile with the digest-pinned image from compose.yaml (the
# exact Caddy production runs), then asserts first-match routing for a request-path corpus.
# Requires docker + python3. No other services, no ports, no build artifacts.
#
# Run from anywhere:  sh infra/test/caddy-routing.sh
# Exit 0 = routing as intended; non-zero = a regression.
# =============================================================================
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)

PIN=$(grep -o 'caddy:2-alpine@sha256:[0-9a-f]*' "$REPO_ROOT/compose.yaml" | head -n1)
if [ -z "$PIN" ]; then
  echo "ERROR: could not extract the pinned caddy image from compose.yaml" >&2
  exit 1
fi

ADAPT_FILE=$(mktemp)
trap 'rm -f "$ADAPT_FILE"' EXIT INT TERM

docker run --rm -v "$REPO_ROOT/infra/caddy:/etc/caddy:ro" "$PIN" \
  caddy adapt --config /etc/caddy/Caddyfile --pretty 2>/dev/null > "$ADAPT_FILE" || {
  echo "ERROR: caddy adapt failed on infra/caddy/Caddyfile" >&2
  exit 1
}

python3 - "$ADAPT_FILE" <<'PYEOF'
import fnmatch
import json
import sys

ADAPT_FILE = sys.argv[1]

# (request path, expected upstream host) — the regression corpus.
# API local-auth password endpoints (issue #1250) MUST reach the API:
CORPUS = [
    ("/api/auth/change-password", "api"),
    ("/api/auth/forgot-password", "api"),
    ("/api/auth/reset-password", "api"),
    ("/api/auth/login", "api"),          # server-side today, but never Auth.js
    ("/api/users", "api"),               # generic API routes
    ("/api/assets", "api"),
    ("/api/health/ready", "api"),
    # Auth.js action paths (ADR-0039) MUST reach the web app:
    ("/api/auth/session", "web"),
    ("/api/auth/csrf", "web"),
    ("/api/auth/providers", "web"),
    ("/api/auth/signin", "web"),
    ("/api/auth/signin/credentials", "web"),
    ("/api/auth/callback/credentials", "web"),
    ("/api/auth/signout", "web"),
    ("/api/auth/verify-request", "web"),
    ("/api/auth/error", "web"),
    ("/api/auth/webauthn-options", "web"),
    # Web UI — everything non-/api falls to the catch-all:
    ("/", "web"),
    ("/login", "web"),
    ("/assets/logo.svg", "web"),
]


def path_pattern_matches(pattern, path):
    # Caddy `path` matcher glob: '*' matches any run of characters, including '/'.
    return fnmatch.fnmatchcase(path, pattern)


def matcher_set_matches(ms, path):
    # A Caddy matcher set dict: {path: [...]} and/or {'not': [matcher_set, ...]}.
    if "path" in ms and not any(path_pattern_matches(p, path) for p in ms["path"]):
        return False
    for neg in ms.get("not", []):
        inner = neg if isinstance(neg, list) else [neg]
        if any(matcher_set_matches(n, path) for n in inner):
            return False
    return True


def route_matches(route, path):
    # route['match'] is a list of matcher sets (OR'd); absent means match everything.
    return any(matcher_set_matches(ms, path) for ms in route.get("match", [{}]))


def route_upstreams(route):
    # Collect reverse_proxy upstream dials, walking subroute handlers.
    dials = []

    def walk(handlers):
        for h in handlers:
            if h.get("handler") == "reverse_proxy":
                dials.extend(up.get("dial", "") for up in h.get("upstreams", []))
            elif h.get("handler") == "subroute":
                for sub in h.get("routes", []):
                    walk(sub.get("handle", []))

    walk(route.get("handle", []))
    return dials


def main_site_routes(data):
    # The main site block is the one with a host matcher for exactly "localhost"
    # (the auth site matches "auth.localhost" — not this one).
    for server in data["apps"]["http"]["servers"].values():
        for route in server.get("routes", []):
            for ms in route.get("match", []):
                if ms.get("host") == ["localhost"]:
                    for h in route.get("handle", []):
                        if h.get("handler") == "subroute":
                            return h.get("routes", [])
    raise SystemExit("ERROR: main site block (host=localhost) not found in adapted Caddy config")


def upstream_for(path, routes):
    # First match wins (the `handle` routes are terminal; the non-terminal middleware
    # route has no upstream, so it is skipped by the empty-dials check below).
    for route in routes:
        if route_matches(route, path):
            dials = route_upstreams(route)
            if dials:
                return dials[0].split(":")[0]
    return None


data = json.load(open(ADAPT_FILE))
routes = main_site_routes(data)
print("Routing table (first match per path):")
for path, _ in CORPUS:
    print(f"  {path:<38} -> {upstream_for(path, routes) or 'NO MATCH'}")

fails = []
for path, expected in CORPUS:
    actual = upstream_for(path, routes)
    if actual != expected:
        fails.append((path, expected, actual))

if fails:
    print("\nFAILED:")
    for path, expected, actual in fails:
        print(f"  {path}: expected {expected}, got {actual}")
    sys.exit(1)
print(f"\nOK — {len(CORPUS)} request paths route as intended")
PYEOF