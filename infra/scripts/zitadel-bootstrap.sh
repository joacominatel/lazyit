#!/bin/sh
# =============================================================================
# lazyit — zitadel-bootstrap (ADR-0043 Phase 3, dossier §4). ZERO-TOUCH provisioner.
#
# Runs ONCE per `--profile prod up` as a sidecar (restart:"no"). It turns a freshly
# `start-from-init`'d Zitadel into a fully-wired OIDC IdP with NO console clicking:
#
#   1. wait for Zitadel `/debug/healthz`
#   2. authenticate to the Management API with the FirstInstance MACHINE key
#      (Private-Key JWT, RFC 7523 — read from $BOOTSTRAP_KEY_PATH, written by Zitadel)
#   3. IDEMPOTENTLY:
#      (a) create/find the `lazyit` PROJECT (assert roles on, so the OIDC token can carry them)
#      (b) create/find the OIDC web APPLICATION (redirect = the Auth.js callback;
#          JWT access token; userinfo + roles asserted into the ID token)
#      (c) create the project ROLES ADMIN / MEMBER / VIEWER  (Phase-2 grantRole prerequisite)
#      (d) create/find a runtime SERVICE-ACCOUNT + Private-Key for the API write-back
#      (e) WRITE  /zitadel-secrets/oidc-client.json  (issuer/client_id/client_secret/jwks)
#                 /zitadel-secrets/sa-key.json        (the runtime SA private key)
#
# FAIL-LOUD: `set -eu` + every step exits non-zero on error, so a misconfig is visible (the
# api/web `depends_on: { condition: service_completed_successfully }` keep them from booting).
# IDEMPOTENT: re-runs are safe — existing project/app/roles/SA are reused, never duplicated.
#
# SECRET SAFETY: the OIDC client secret + the SA private key are shown by Zitadel ONLY ONCE
# (at creation). So when /zitadel-secrets/oidc-client.json AND /zitadel-secrets/sa-key.json
# already exist this script SHORT-CIRCUITS as already-provisioned (it cannot re-read the
# secret of an existing app). For a clean re-bootstrap, `down -v` AND remove the
# zitadel_secrets volume (dossier §4e) — documented in docs/05-runbooks/auth-bootstrap.md.
#
# NETWORK SHAPE (mirrors apps/api jwt-auth.guard.ts + zitadel-management.service.ts): reach
# Zitadel at its INTERNAL origin ($ZITADEL_INTERNAL_URL, default http://zitadel:8080) while
# forwarding the EXTERNAL host/proto (derived from $OIDC_ISSUER) via X-Forwarded-Host/-Proto,
# so Zitadel resolves the right instance (otherwise: 404 "Instance not found"). The JWT `aud`
# is the EXTERNAL issuer (what Zitadel signs/expects).
# =============================================================================
set -eu

# ---------- config (env, with sensible internal defaults) --------------------
SECRETS_DIR="${ZITADEL_SECRETS_DIR:-/zitadel-secrets}"
BOOTSTRAP_KEY_PATH="${ZITADEL_BOOTSTRAP_KEY_PATH:-${SECRETS_DIR}/bootstrap-key.json}"
OIDC_CLIENT_OUT="${SECRETS_DIR}/oidc-client.json"
SA_KEY_OUT="${SECRETS_DIR}/sa-key.json"

# Internal origin to reach Zitadel at (Docker DNS). External issuer = the public, advertised URL.
ZITADEL_INTERNAL_URL="${ZITADEL_INTERNAL_URL:-http://zitadel:8080}"
# OIDC_ISSUER is REQUIRED: it is the JWT `aud`, the X-Forwarded-Host source, and the issuer the
# api/web record in oidc-client.json. e.g. https://auth.lazyit.example.com
OIDC_ISSUER="${OIDC_ISSUER:-}"

# The names/identifiers we provision. Overridable but default to the lazyit conventions.
PROJECT_NAME="${ZITADEL_PROJECT_NAME:-lazyit}"
APP_NAME="${ZITADEL_APP_NAME:-lazyit-web}"
SA_USERNAME="${ZITADEL_API_SA_USERNAME:-lazyit-api}"
SA_NAME="${ZITADEL_API_SA_NAME:-lazyit API write-back service account}"

# The Auth.js callback. WEB_ORIGIN is the external browser origin (e.g. https://localhost:8443);
# the provider id is `oidc` (apps/web/auth.ts). Override REDIRECT_URI directly to bypass.
WEB_ORIGIN="${WEB_ORIGIN:-}"
REDIRECT_URI="${ZITADEL_REDIRECT_URI:-}"
POST_LOGOUT_URI="${ZITADEL_POST_LOGOUT_URI:-}"

# Health-wait tuning.
HEALTH_RETRIES="${ZITADEL_HEALTH_RETRIES:-60}"
HEALTH_INTERVAL="${ZITADEL_HEALTH_INTERVAL:-3}"

MGMT="${ZITADEL_INTERNAL_URL%/}/management/v1"

# ---------- helpers ----------------------------------------------------------
log()  { printf '[zitadel-bootstrap] %s\n' "$*"; }
fail() { printf '[zitadel-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

# True when an HTTP status code ($1) is 2xx.
is_2xx() { case "$1" in 2??) return 0;; *) return 1;; esac; }

# base64url (no padding) of stdin — for the JWT segments.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# The X-Forwarded-* headers derived from the external issuer (so Zitadel resolves the instance).
# Only meaningful when the internal origin differs from the external issuer — but always safe to send.
ext_host() { printf '%s' "$OIDC_ISSUER" | sed -E 's#^[a-zA-Z]+://([^/]+).*#\1#'; }
ext_proto() { printf '%s' "$OIDC_ISSUER" | sed -E 's#^([a-zA-Z]+)://.*#\1#'; }

# A Management-API call: $1=METHOD $2=PATH(relative to $MGMT) $3=JSON-body(optional).
# Echoes the response body on stdout; FAILS LOUD on a non-2xx (prints status + body to stderr).
# The access token + forwarded headers are injected. NEVER echoes the bearer token.
api() {
  _method="$1"; _path="$2"; _body="${3:-}"
  _url="${MGMT}${_path}"
  _tmp_body="$(mktemp)"
  # `|| _http=000` keeps a curl transport failure from tripping `set -e` here, so the structured
  # non-2xx branch below reports it (and the caller's `|| fail` fires) instead of a bare abort.
  if [ -n "$_body" ]; then
    _http="$(curl -sS -o "$_tmp_body" -w '%{http_code}' -X "$_method" "$_url" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      -H "X-Forwarded-Host: $(ext_host)" \
      -H "X-Forwarded-Proto: $(ext_proto)" \
      -d "$_body")" || _http=000
  else
    _http="$(curl -sS -o "$_tmp_body" -w '%{http_code}' -X "$_method" "$_url" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H "Accept: application/json" \
      -H "X-Forwarded-Host: $(ext_host)" \
      -H "X-Forwarded-Proto: $(ext_proto)")" || _http=000
  fi
  if ! is_2xx "$_http"; then
    log "Management API ${_method} ${_path} -> HTTP ${_http}"
    cat "$_tmp_body" >&2 || true
    rm -f "$_tmp_body"
    return 1
  fi
  cat "$_tmp_body"
  rm -f "$_tmp_body"
}

# ---------- 0. preflight ------------------------------------------------------
[ -n "$OIDC_ISSUER" ] || fail "OIDC_ISSUER is required (the external auth URL, e.g. https://auth.lazyit.example.com)"
[ -d "$SECRETS_DIR" ] || fail "secrets dir ${SECRETS_DIR} is not mounted"

# Derive the redirect/post-logout URIs from WEB_ORIGIN if not given explicitly.
if [ -z "$REDIRECT_URI" ]; then
  [ -n "$WEB_ORIGIN" ] || fail "set WEB_ORIGIN (e.g. https://localhost:8443) or ZITADEL_REDIRECT_URI"
  REDIRECT_URI="${WEB_ORIGIN%/}/api/auth/callback/oidc"
fi
[ -n "$POST_LOGOUT_URI" ] || POST_LOGOUT_URI="${WEB_ORIGIN%/}"

# IDEMPOTENT SHORT-CIRCUIT: both secret files already present → nothing to do (the app secret +
# SA key cannot be re-read after creation; re-running would only risk dup objects). For a clean
# re-bootstrap, remove the zitadel_secrets volume (dossier §4e).
if [ -s "$OIDC_CLIENT_OUT" ] && [ -s "$SA_KEY_OUT" ]; then
  log "already provisioned: ${OIDC_CLIENT_OUT} and ${SA_KEY_OUT} exist — nothing to do (idempotent)."
  log "for a clean re-bootstrap: \`down -v\` AND remove the zitadel_secrets volume."
  exit 0
fi

# ---------- 1. wait for Zitadel healthy --------------------------------------
log "waiting for Zitadel health at ${ZITADEL_INTERNAL_URL}/debug/healthz (up to $((HEALTH_RETRIES * HEALTH_INTERVAL))s) ..."
_n=0
while :; do
  if curl -sf -o /dev/null "${ZITADEL_INTERNAL_URL%/}/debug/healthz"; then
    log "Zitadel is healthy."
    break
  fi
  _n=$((_n + 1))
  [ "$_n" -lt "$HEALTH_RETRIES" ] || fail "Zitadel did not become healthy in time"
  sleep "$HEALTH_INTERVAL"
done

# ---------- 2. authenticate (Private-Key JWT → Management token) -------------
[ -s "$BOOTSTRAP_KEY_PATH" ] || fail "FirstInstance machine key not found at ${BOOTSTRAP_KEY_PATH} (did Zitadel export ZITADEL_FIRSTINSTANCE_MACHINEKEYPATH into the volume? check secrets-dir ownership — dossier §4e)"

KEY_ID="$(jq -r '.keyId' "$BOOTSTRAP_KEY_PATH")"
USER_ID="$(jq -r '.userId' "$BOOTSTRAP_KEY_PATH")"
[ -n "$KEY_ID" ] && [ "$KEY_ID" != "null" ] || fail "bootstrap key JSON missing keyId"
[ -n "$USER_ID" ] && [ "$USER_ID" != "null" ] || fail "bootstrap key JSON missing userId"

# Extract the PEM private key to a temp file (jq -r preserves the embedded \n as real newlines).
PEM="$(mktemp)"
jq -r '.key' "$BOOTSTRAP_KEY_PATH" > "$PEM"
[ -s "$PEM" ] || fail "bootstrap key JSON missing key (PEM)"

# Build the RFC-7523 assertion: header{alg:RS256,kid}, claims{iss=sub=userId, aud=issuer, iat, exp}.
_now="$(date +%s)"
_exp="$((_now + 600))"   # Zitadel caps JWT-profile assertions at 1h; 10m is plenty.
_hdr="$(printf '{"alg":"RS256","kid":"%s","typ":"JWT"}' "$KEY_ID" | b64url)"
_pl="$(printf '{"iss":"%s","sub":"%s","aud":"%s","iat":%s,"exp":%s}' \
  "$USER_ID" "$USER_ID" "$OIDC_ISSUER" "$_now" "$_exp" | b64url)"
_signing_input="${_hdr}.${_pl}"
_sig="$(printf '%s' "$_signing_input" | openssl dgst -sha256 -sign "$PEM" -binary | b64url)"
ASSERTION="${_signing_input}.${_sig}"
rm -f "$PEM"

log "exchanging the machine-key assertion for a Management-API token ..."
_tok_body="$(mktemp)"
_tok_code="$(curl -sS -o "$_tok_body" -w '%{http_code}' -X POST "${ZITADEL_INTERNAL_URL%/}/oauth/v2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Forwarded-Host: $(ext_host)" \
  -H "X-Forwarded-Proto: $(ext_proto)" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  --data-urlencode "scope=openid urn:zitadel:iam:org:project:id:zitadel:aud" \
  --data-urlencode "assertion=${ASSERTION}")" || _tok_code=000
if ! is_2xx "$_tok_code"; then
  log "token endpoint returned HTTP ${_tok_code}"
  # NEVER print the request (it carries the assertion); the response body is safe (an OAuth error).
  cat "$_tok_body" >&2 || true
  rm -f "$_tok_body"
  fail "could not obtain a Management-API token (check the bootstrap key + OIDC_ISSUER/EXTERNALDOMAIN match)"
fi
ACCESS_TOKEN="$(jq -r '.access_token' "$_tok_body")"
rm -f "$_tok_body"
[ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != "null" ] || fail "token response had no access_token"
log "authenticated to the Management API."

# ---------- 3a. project (create or find) -------------------------------------
log "ensuring project '${PROJECT_NAME}' ..."
_proj_search="$(api POST /projects/_search \
  "$(jq -nc --arg n "$PROJECT_NAME" '{queries:[{nameQuery:{name:$n,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')")" \
  || fail "project search failed"
PROJECT_ID="$(printf '%s' "$_proj_search" | jq -r '.result[]?.id' | head -n1)"

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "null" ]; then
  # projectRoleAssertion=true → the OIDC token can carry the project roles (provenance, dossier §1c).
  _proj_create="$(api POST /projects \
    "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n,projectRoleAssertion:true,projectRoleCheck:false,hasProjectCheck:false}')")" \
    || fail "project create failed"
  PROJECT_ID="$(printf '%s' "$_proj_create" | jq -r '.id // .projectId')"
  [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || fail "project create response had no id"
  log "created project '${PROJECT_NAME}' (id=${PROJECT_ID})."
else
  log "found existing project '${PROJECT_NAME}' (id=${PROJECT_ID}) — reusing."
fi

# ---------- 3c. project roles ADMIN/MEMBER/VIEWER (idempotent) ----------------
# Do this BEFORE the app: the app may assert roles, and Phase-2 grantRole needs these keys to exist.
# AddProjectRole 409s if a key already exists; we tolerate that so re-runs are safe.
for _role in ADMIN:Administrator MEMBER:Member VIEWER:Viewer; do
  _key="${_role%%:*}"; _disp="${_role#*:}"
  _role_body="$(jq -nc --arg k "$_key" --arg d "$_disp" '{roleKey:$k,displayName:$d,group:"lazyit"}')"
  _rtmp="$(mktemp)"
  _rcode="$(curl -sS -o "$_rtmp" -w '%{http_code}' -X POST "${MGMT}/projects/${PROJECT_ID}/roles" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" -H "Content-Type: application/json" -H "Accept: application/json" \
    -H "X-Forwarded-Host: $(ext_host)" -H "X-Forwarded-Proto: $(ext_proto)" -d "$_role_body")" || _rcode=000
  if is_2xx "$_rcode"; then
    log "  + role ${_key} created."
  elif [ "$_rcode" = "409" ] || grep -qiE 'already exists|AlreadyExists' "$_rtmp"; then
    log "  = role ${_key} already exists — ok."
  else
    log "role ${_key} create -> HTTP ${_rcode}"; cat "$_rtmp" >&2 || true; rm -f "$_rtmp"; fail "could not create role ${_key}"
  fi
  rm -f "$_rtmp"
done

# ---------- 3b. OIDC web application (create or find) -------------------------
log "ensuring OIDC application '${APP_NAME}' ..."
_app_search="$(api POST "/projects/${PROJECT_ID}/apps/_search" \
  "$(jq -nc --arg n "$APP_NAME" '{queries:[{nameQuery:{name:$n,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')")" \
  || fail "app search failed"
_existing_app_id="$(printf '%s' "$_app_search" | jq -r '.result[]?.id' | head -n1)"

if [ -n "$_existing_app_id" ] && [ "$_existing_app_id" != "null" ]; then
  # The client secret is unrecoverable for an existing app. If we reached here, oidc-client.json was
  # missing (short-circuit above) yet the app exists → the operator removed only the secret file, or a
  # prior run failed mid-way. FAIL LOUD with a precise remedy rather than write a half-broken file.
  fail "OIDC app '${APP_NAME}' already exists (id=${_existing_app_id}) but ${OIDC_CLIENT_OUT} is missing. The client secret is unrecoverable. Remove the zitadel_secrets volume AND \`down -v\` for a clean re-bootstrap (dossier §4e), or delete the app in the console and re-run."
fi

# Web app, Authorization Code, client-secret-basic, JWT access token, userinfo + roles in the ID token.
_app_body="$(jq -nc \
  --arg name "$APP_NAME" \
  --arg redirect "$REDIRECT_URI" \
  --arg logout "$POST_LOGOUT_URI" \
  '{
     name: $name,
     redirectUris: [$redirect],
     postLogoutRedirectUris: [$logout],
     responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
     grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
     appType: "OIDC_APP_TYPE_WEB",
     authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
     version: "OIDC_VERSION_1_0",
     accessTokenType: "OIDC_TOKEN_TYPE_JWT",
     accessTokenRoleAssertion: true,
     idTokenRoleAssertion: true,
     idTokenUserinfoAssertion: true,
     devMode: false
   }')"
_app_create="$(api POST "/projects/${PROJECT_ID}/apps/oidc" "$_app_body")" || fail "OIDC app create failed"
CLIENT_ID="$(printf '%s' "$_app_create" | jq -r '.clientId')"
CLIENT_SECRET="$(printf '%s' "$_app_create" | jq -r '.clientSecret')"
[ -n "$CLIENT_ID" ] && [ "$CLIENT_ID" != "null" ] || fail "OIDC app create response had no clientId"
[ -n "$CLIENT_SECRET" ] && [ "$CLIENT_SECRET" != "null" ] || fail "OIDC app create response had no clientSecret"
log "created OIDC application '${APP_NAME}' (client_id=${CLIENT_ID})."

# ---------- 3d. runtime service-account + private key -------------------------
log "ensuring runtime service-account '${SA_USERNAME}' ..."
_sa_search="$(api POST /users/_search \
  "$(jq -nc --arg n "$SA_USERNAME" '{queries:[{userNameQuery:{userName:$n,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')")" \
  || fail "service-account search failed"
SA_USER_ID="$(printf '%s' "$_sa_search" | jq -r '.result[]?.id' | head -n1)"

if [ -z "$SA_USER_ID" ] || [ "$SA_USER_ID" = "null" ]; then
  _sa_create="$(api POST /users/machine \
    "$(jq -nc --arg u "$SA_USERNAME" --arg n "$SA_NAME" \
      '{userName:$u,name:$n,description:"lazyit API → Zitadel write-back (ADR-0043 Phase 2)",accessTokenType:"ACCESS_TOKEN_TYPE_JWT"}')")" \
    || fail "service-account create failed"
  SA_USER_ID="$(printf '%s' "$_sa_create" | jq -r '.userId')"
  [ -n "$SA_USER_ID" ] && [ "$SA_USER_ID" != "null" ] || fail "service-account create response had no userId"
  log "created service-account '${SA_USERNAME}' (id=${SA_USER_ID})."
else
  log "found existing service-account '${SA_USERNAME}' (id=${SA_USER_ID}) — reusing."
fi

# The runtime SA must be able to grant/revoke project roles + (de)activate users for write-back.
# Grant it ORG_USER_MANAGER on the org (covers user lifecycle + grants). 409 if already granted.
_mm_body="$(jq -nc --arg u "$SA_USER_ID" '{userId:$u,roles:["ORG_USER_MANAGER"]}')"
_mmtmp="$(mktemp)"
_mmcode="$(curl -sS -o "$_mmtmp" -w '%{http_code}' -X POST "${MGMT}/orgs/me/members" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" -H "Content-Type: application/json" -H "Accept: application/json" \
  -H "X-Forwarded-Host: $(ext_host)" -H "X-Forwarded-Proto: $(ext_proto)" -d "$_mm_body")" || _mmcode=000
if is_2xx "$_mmcode"; then
  log "  + granted ORG_USER_MANAGER to '${SA_USERNAME}'."
elif [ "$_mmcode" = "409" ] || grep -qiE 'already exists|AlreadyExists' "$_mmtmp"; then
  log "  = '${SA_USERNAME}' already an org member — ok."
else
  log "org member add -> HTTP ${_mmcode}"; cat "$_mmtmp" >&2 || true; rm -f "$_mmtmp"; fail "could not grant ORG_USER_MANAGER to the service-account"
fi
rm -f "$_mmtmp"

# Generate the SA private key (JSON). keyDetails is the base64 of the FULL machine-key JSON file that
# apps/api's ZitadelManagementService reads (keyId/userId/key PEM). We decode it to sa-key.json.
log "generating the runtime service-account private key ..."
_key_create="$(api POST "/users/${SA_USER_ID}/keys" \
  "$(jq -nc '{type:"KEY_TYPE_JSON"}')")" || fail "service-account key create failed"
_key_details="$(printf '%s' "$_key_create" | jq -r '.keyDetails')"
[ -n "$_key_details" ] && [ "$_key_details" != "null" ] || fail "key create response had no keyDetails"

# ---------- 3e. write the two secret files (atomic) --------------------------
umask 077
_sa_tmp="$(mktemp -p "$SECRETS_DIR")"
printf '%s' "$_key_details" | base64 -d > "$_sa_tmp" 2>/dev/null || printf '%s' "$_key_details" | base64 --decode > "$_sa_tmp"
jq -e '.keyId and .userId and .key' "$_sa_tmp" >/dev/null 2>&1 || fail "decoded SA key is not a valid Zitadel machine-key JSON"
mv -f "$_sa_tmp" "$SA_KEY_OUT"
log "wrote ${SA_KEY_OUT} (runtime SA private key for ZITADEL_MGMT_SA_KEY_PATH)."

_oc_tmp="$(mktemp -p "$SECRETS_DIR")"
jq -nc \
  --arg issuer "$OIDC_ISSUER" \
  --arg cid "$CLIENT_ID" \
  --arg csec "$CLIENT_SECRET" \
  --arg jwks "${ZITADEL_INTERNAL_URL%/}/oauth/v2/keys" \
  --arg proj "$PROJECT_ID" \
  '{OIDC_ISSUER:$issuer, OIDC_CLIENT_ID:$cid, OIDC_CLIENT_SECRET:$csec, OIDC_JWKS_URI:$jwks, ZITADEL_MGMT_PROJECT_ID:$proj}' \
  > "$_oc_tmp"
mv -f "$_oc_tmp" "$OIDC_CLIENT_OUT"
log "wrote ${OIDC_CLIENT_OUT} (issuer/client_id/client_secret/jwks/project for api+web)."

log "DONE — Zitadel is provisioned. project=${PROJECT_ID} app=${CLIENT_ID} sa=${SA_USER_ID}"
