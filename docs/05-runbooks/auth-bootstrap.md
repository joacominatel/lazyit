---
title: OIDC Sign-in With Your Own IdP
tags: [runbook, auth, oidc, byoi]
status: accepted
created: 2026-05-26
updated: 2026-10-09
---

# Runbook — sign in with your own OIDC IdP (BYOI)

lazyit's default is **built-in accounts** (`AUTH_MODE=local`, [[0086-local-authentication-mode]]): no
IdP, nothing in this runbook applies. This runbook wires the opt-in alternative, `AUTH_MODE=oidc`,
against an identity provider **you already run** — Entra ID, Okta, Keycloak, Authentik, a Zitadel of
your own, or any other OIDC-compliant IdP. lazyit ships no IdP of its own
([[0102-remove-bundled-zitadel]]).

Configuration is **environment variables only**: there is no in-app OIDC configuration and no client
secret stored in the database. `AUTH_MODE` is chosen **once per instance** — the first `/setup` records
it and every later boot refuses a different value ([[0086-local-authentication-mode]] §1) — so decide
before you create the first admin.

> [!warning] Still running the bundled Zitadel?
> An install wired to the removed bundled Zitadel (`ZITADEL_MASTERKEY`, or an issuer at
> `zitadel:8080`) is refused by `start.sh`, `update.sh` and the API. Follow
> [[migrate-off-bundled-zitadel]] first.

## 1 — What lazyit needs from the IdP

| Need | Why |
| --- | --- |
| OIDC discovery at `<issuer>/.well-known/openid-configuration` | The web (Auth.js) and the API find the endpoints there. |
| A **confidential web client**, authorization-code flow, with a client id and secret | The web signs people in with it ([[0039-authjs-v5-frontend-oidc]]). |
| Redirect URI **`https://<your-domain>/api/auth/callback/oidc`** | The exact path the web listens on. Use your `WEB_ORIGIN`, port included when it is not 443 (e.g. `https://localhost:8443/api/auth/callback/oidc`). |
| Scopes **`openid profile email offline_access`** | The web asks for all four. `offline_access` yields a refresh token for silent renewal; without it a session simply ends when its access token expires. |
| **Access tokens as JWTs signed RS256**, with `iss` equal to the issuer | The API verifies the bearer access token against the IdP's JWKS and accepts RS256 only. An IdP that issues opaque access tokens by default must be switched to JWT for this client. |
| `email` and `email_verified` claims (ID token or userinfo) | A verified email is the only key that links an IdP account to an existing lazyit person, including the first admin (§4). |
| `name` or `given_name` / `family_name` | Shown in the app; falls back to `preferred_username`. |

## 2 — Register the client in your IdP

The labels differ per IdP; the values do not:

1. Create a **web application** (confidential client, authorization code; PKCE on is fine).
2. Add the redirect URI from §1.
3. Allow the scopes from §1 and set the access-token format to **JWT** where the IdP offers a choice.
4. Assign the people who should reach lazyit to the application, per your IdP's access model.
5. Copy the **issuer URL**, the **client id** and the **client secret**, and read the `jwks_uri` from
   discovery:

   ```sh
   curl -s https://login.example.com/.well-known/openid-configuration | grep -o '"jwks_uri":"[^"]*"'
   ```

## 3 — Configure lazyit

### 3a. Guided install

Run `./infra/start.sh`, choose network mode `local` or `real`, and answer **`byoi`** at the
authentication question. It asks for the issuer, the `jwks_uri`, the client id and the client secret,
and writes them to `infra/env/.env.prod` (mode 600). `lan` mode cannot use OIDC: a redirect URI is
registered against one fixed origin.

### 3b. By hand

Set these in `infra/env/.env.prod` (the example ships them commented) — the same keys the `/setup`
wizard shows:

```sh
# API — validates the access token on every request
AUTH_MODE=oidc
OIDC_ISSUER=https://login.example.com
OIDC_JWKS_URI=https://login.example.com/oauth2/keys    # the jwks_uri from discovery
OIDC_CLIENT_ID=<client id>                              # optional — when set, the token's aud must contain it

# Web — signs people in (Auth.js)
AUTH_ISSUER=https://login.example.com
AUTH_CLIENT_ID=<client id>
AUTH_CLIENT_SECRET=<client secret>
```

Then bring the stack up as usual ([[deploy-self-hosted]] §2). The API **refuses to boot** under
`AUTH_MODE=oidc` without `OIDC_ISSUER` and `OIDC_JWKS_URI`, and logs which one is missing.

- The **API never reads a client secret**: it is a resource server. An `OIDC_CLIENT_SECRET` line
  written by an older `start.sh` is unused and can be deleted.
- Leave **`OIDC_CLIENT_ID` unset** when your IdP puts a resource audience (not the client id) in access
  tokens; set it to tighten validation when the client id is in `aud`.
- `IDENTITY_PROVIDER_TYPE` is no longer read; a leftover `zitadel` value only logs a warning at boot.
- `SESSION_SIGNING_SECRET` is unused under OIDC.

### 3c. An IdP on the same host (`AUTH_INTERNAL_ISSUER`)

When the IdP runs on the same host or Docker network, its public hostname often does not resolve —
or hairpins badly — from inside the lazyit containers. Keep the public URL in `OIDC_ISSUER` and
`AUTH_ISSUER` (it is what the browser and the token's `iss` use) and add internal routes:

- **Web:** `AUTH_INTERNAL_ISSUER=http://<internal-host>:<port>`. Server-side discovery, token and
  userinfo calls go to that origin with `X-Forwarded-Host` / `X-Forwarded-Proto` taken from
  `AUTH_ISSUER`; the browser redirect still uses `AUTH_ISSUER`.
- **API:** point `OIDC_JWKS_URI` at the internal origin (e.g.
  `http://<internal-host>:<port>/oauth/v2/keys`). The API sends its JWKS, discovery and userinfo
  requests to that origin, with forwarded headers taken from `OIDC_ISSUER`.

The containers must be able to reach `<internal-host>` — attach the IdP to a network the `api` and
`web` services share, or use an address both can route to.

## 4 — The first admin

1. Open `https://<your-domain>/setup` — a fresh instance sends every visitor there. Under OIDC the
   wizard shows the env snippet above and asks for the first admin's **email and name**, no password:
   your IdP owns the credential.
2. Sign in with the IdP account whose **verified** email is that address. The first sign-in links the
   account to the admin you created, and it keeps the ADMIN role.

On an empty instance the very first IdP sign-in becomes ADMIN even without `/setup`. An account whose
email the IdP has not verified is refused (403) rather than linked.

**Fallback — grant ADMIN out-of-band.** When an operator lands as `VIEWER` with no admin to promote
them (an upgraded instance with existing users, or a seeded `SEED_ADMIN_EMAIL` nobody can sign in as),
have them sign in once, then run the `set-role` script from the `migrate` image (the API runtime image
has no Bun):

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run set-role operator@yourco.com ADMIN
```

It matches the email case-insensitively and targets live users only. Valid roles are `ADMIN`, `MEMBER`
and `VIEWER`. After that, roles are managed in **Users**; the API refuses to remove the last admin.

## 5 — People under OIDC

- **Onboarding** happens in the IdP. A person's first sign-in creates their lazyit account as
  `VIEWER` ([[0038-jit-user-provisioning]]), or links an existing one — a directory-imported person or
  one an admin created — that has the same verified email and no identity yet.
- **Each person is bound to the IdP's subject (`sub`)** on first sign-in, and never re-bound. A
  different `sub` with the same email is refused (409 *"This email is already linked to a different
  identity"*). So an IdP rebuilt with new subjects, or a move to another IdP, does not carry people
  over — lazyit has no tooling for it.
- **Passwords, MFA and sessions** are the IdP's. lazyit offers no password reset under OIDC.
- **Offboarding** in lazyit soft-deletes the person and refuses their next sign-in (403) — **if they
  have signed in before**. It does not touch the IdP: **disable the account in your IdP too**. A person
  offboarded before their first sign-in is stopped only by the IdP ([[0102-remove-bundled-zitadel]] §5).

## 6 — Troubleshooting

**The API does not start.** Read its log (`… logs api`). *"OIDC_ISSUER: is required in OIDC mode"* or
the same for `OIDC_JWKS_URI`: set it (§3b). *"… is a leftover of the bundled Zitadel"*: see
[[migrate-off-bundled-zitadel]].

**Sign-in works, then every page fails with 401.** The API rejected the access token:
- the IdP issues **opaque** access tokens — switch the client to JWT;
- the token is not **RS256**;
- `iss` differs from `OIDC_ISSUER` — compare them character for character, trailing slash included;
- `OIDC_CLIENT_ID` is set but not in the token's `aud` — unset it, or match the IdP's audience.

**The IdP says `redirect_uri` mismatch.** Register exactly `<WEB_ORIGIN>/api/auth/callback/oidc`,
scheme and port included.

**`invalid_client` on the callback.** `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` do not match the IdP.
Many IdPs show a secret only once — rotate it and set the new one.

**409 "already linked to a different identity".** The person's `sub` changed (§5).

**403 on first sign-in for an existing person.** The IdP did not send `email_verified=true`.

**The web cannot reach the IdP from inside its container** (sign-in fails before the IdP page, with a
fetch error in `… logs web`). Use §3c.

---

Related: [[0102-remove-bundled-zitadel]] · [[0086-local-authentication-mode]] ·
[[0038-jit-user-provisioning]] · [[0039-authjs-v5-frontend-oidc]] · [[deploy-self-hosted]] ·
[[migrate-off-bundled-zitadel]] · [[0028-secrets-and-config]]
