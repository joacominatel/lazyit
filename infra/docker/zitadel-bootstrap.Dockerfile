# syntax=docker/dockerfile:1
#
# lazyit zitadel-bootstrap sidecar — a ONE-SHOT, fail-loud provisioner (ADR-0043 Phase 3, §4).
# It waits for Zitadel to become healthy, authenticates to the Management API with the FirstInstance
# machine key (Private-Key JWT, RFC 7523), and IDEMPOTENTLY provisions the lazyit OIDC integration:
#   - the `lazyit` PROJECT
#   - the OIDC web APPLICATION (redirect = the Auth.js callback; JWT access token; roles asserted)
#   - the project ROLES ADMIN / MEMBER / VIEWER (Phase-2 grantRole prerequisite)
#   - a runtime SERVICE-ACCOUNT + Private-Key for the API write-back
# then WRITES `oidc-client.json` (issuer/client_id/client_secret/jwks) + `sa-key.json` (the runtime
# SA private key) into the shared `zitadel_secrets` volume for api/web to consume at startup.
#
# Build from the repo ROOT:
#   docker build -f infra/docker/zitadel-bootstrap.Dockerfile -t lazyit-zitadel-bootstrap:dev .
#
# TINY by design: a shell + curl + jq + openssl, nothing else. Digest-pinned (ADR-0025 follow-up) so
# a re-pulled tag can't change underneath a deploy. Re-pin after a deliberate bump with:
#   docker pull alpine:3.21 && docker inspect alpine:3.21 --format '{{index .RepoDigests 0}}'

# alpine:3.21 — pinned by digest.
FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

# curl (HTTP to the Management API + healthcheck), jq (JSON build/parse), openssl (RS256 JWT signing),
# coreutils (base64 -w0 / printf %s for the JWT), ca-certificates (TLS to any external issuer). No bash:
# the script is POSIX `sh`. Versions float within 3.21's repo; the base image is digest-pinned.
RUN apk add --no-cache curl jq openssl coreutils ca-certificates

# The one-shot provisioner. Copied (not bind-mounted) so the image is self-contained and the build
# context is the repo root (matching the other infra Dockerfiles).
COPY infra/scripts/zitadel-bootstrap.sh /usr/local/bin/zitadel-bootstrap.sh
RUN chmod +x /usr/local/bin/zitadel-bootstrap.sh

# FAIL-LOUD: `set -eu` inside the script + restart:"no" in compose means any non-zero exit is visible
# to the operator (the api/web depend_on this completing successfully, so they won't start on failure).
ENTRYPOINT ["/usr/local/bin/zitadel-bootstrap.sh"]
