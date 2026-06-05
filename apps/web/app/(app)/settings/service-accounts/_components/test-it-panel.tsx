"use client";

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import {
  type Permission,
  type PermissionDomain,
  READ_PERMISSIONS,
  WRITE_PERMISSIONS,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/copy-button";

/**
 * TestItPanel — a permission-aware "how to test this works" help block for a service account
 * (issue #197, ADR-0048). After minting/scoping an `lzit_sa_<id>_<secret>` token the operator has
 * nothing in-app to verify it actually works; this derives — purely from `account.permissions` — at
 * most THREE copy-pasteable `curl` checks (a Read GET, a Write POST, an Admin/settings GET) and shows
 * only the buckets the account qualifies for.
 *
 * Design (ADR-0049 «Activated Restraint»): no new accent colours and no new vendored primitive — each
 * check is a plain bordered section reusing the screen's existing `bg-muted` code treatment and the
 * shared {@link CopyButton} (which already honours `prefers-reduced-motion`). The token is ALWAYS a
 * `<…>` placeholder — only `tokenPrefix` ever exists client-side (`service-account.ts`), so a real
 * secret can never be baked into a snippet (it would persist in clipboard/shell history).
 */

/** Bare-route base URL the API serves on in dev. The PUBLIC prod path is `/api/*` via Caddy (see note). */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** The placeholder token. NEVER a real secret — only `tokenPrefix` exists on the client. */
const TOKEN_PLACEHOLDER = "lzit_sa_<id>_<secret>";

/** Which check a derived snippet represents — drives the heading copy and expected status. */
type CheckTier = "read" | "write" | "admin";

interface TestCheck {
  readonly tier: CheckTier;
  /** HTTP method shown in the heading. */
  readonly method: "GET" | "POST";
  /** The bare API path (no host), e.g. `/assets`. */
  readonly path: string;
  /** Minimal, clearly-sample request body (write checks only). */
  readonly body?: string;
  /** The success status the operator should see. */
  readonly expect: 200 | 201;
}

/**
 * Catalog-domain → the bare API path of the GET endpoint actually GATED on that domain's `:read`
 * permission. Verified 1:1 against the controllers, NOT guessed: most domains are a plural list
 * (`/assets`), but several are not — `category` is four taxonomies (`category:read` gates the asset
 * taxonomy `GET /asset-categories`), `assetModel`→`/asset-models`, `accessGrant`→`/access-grants`, and
 * the two read-only surfaces gate sub-routes (`dashboard:read`→`GET /dashboard/summary`,
 * `logs:read`→`GET /dashboard/activity`). A domain with no entry here is simply skipped as a
 * representative — never pointed at a non-existent route.
 */
const DOMAIN_GET_PATH: Partial<Record<PermissionDomain, string>> = {
  asset: "/assets",
  consumable: "/consumables",
  application: "/applications",
  accessGrant: "/access-grants",
  article: "/articles",
  location: "/locations",
  assetModel: "/asset-models",
  category: "/asset-categories", // the asset taxonomy — the representative for `category:read`
  user: "/users",
  dashboard: "/dashboard/summary", // GET /dashboard/summary is gated on dashboard:read
  search: "/search",
  logs: "/dashboard/activity", // GET /dashboard/activity is gated on logs:read (issue #181)
};

/**
 * Domains with a safe, minimal representative POST for the Write check. Only domains whose create body
 * is a tiny, clearly-sample object are listed — never a destructive write. The body is illustrative,
 * not idempotent: the operator sees a 201 (and can delete the sample), which is enough to prove the
 * token's write scope works.
 */
const DOMAIN_WRITE: Partial<Record<PermissionDomain, { path: string; body: string }>> = {
  asset: {
    path: "/assets",
    body: '{ "name": "token-smoke-test", "status": "IN_STORAGE" }',
  },
  location: {
    path: "/locations",
    body: '{ "name": "token-smoke-test", "type": "OTHER" }',
  },
  consumable: {
    path: "/consumables",
    body: '{ "name": "token-smoke-test" }',
  },
};

/** The `domain` half of a `domain:action` literal. */
function domainOf(permission: Permission): PermissionDomain {
  return permission.split(":")[0] as PermissionDomain;
}

/**
 * Derive at most three representative checks from the account's permissions, deterministically and
 * purely from the shared catalog (`READ_PERMISSIONS` / `WRITE_PERMISSIONS` / `settings:manage`):
 *   - Read  — prefer `asset:read` → `GET /assets`; else the first held `:read` domain with a path.
 *   - Write — prefer `asset:write` → `POST /assets`; else the first held `:write` domain with a safe
 *             representative body. Never a destructive write.
 *   - Admin — `settings:manage` → `GET /service-accounts` (the SA list, `settings:manage`-gated).
 * Renders nothing for buckets the account doesn't qualify for.
 */
export function deriveTestChecks(permissions: readonly Permission[]): TestCheck[] {
  const held = new Set(permissions);
  const checks: TestCheck[] = [];

  // Read — any `:read` the account holds (prefer asset:read), mapped to a concrete GET.
  const heldReads = READ_PERMISSIONS.filter((p) => held.has(p));
  const readPerm =
    heldReads.find((p) => p === "asset:read") ??
    heldReads.find((p) => DOMAIN_GET_PATH[domainOf(p)] != null);
  if (readPerm) {
    const path = DOMAIN_GET_PATH[domainOf(readPerm)];
    if (path) checks.push({ tier: "read", method: "GET", path, expect: 200 });
  }

  // Write — any `:write` the account holds (prefer asset:write) with a safe sample body.
  const heldWrites = WRITE_PERMISSIONS.filter((p) => held.has(p));
  const writePerm =
    heldWrites.find((p) => p === "asset:write") ??
    heldWrites.find((p) => DOMAIN_WRITE[domainOf(p)] != null);
  if (writePerm) {
    const write = DOMAIN_WRITE[domainOf(writePerm)];
    if (write) {
      checks.push({
        tier: "write",
        method: "POST",
        path: write.path,
        body: write.body,
        expect: 201,
      });
    }
  }

  // Admin — the coarse settings verb maps to the SA management list (settings:manage-gated).
  if (held.has("settings:manage")) {
    checks.push({
      tier: "admin",
      method: "GET",
      path: "/service-accounts",
      expect: 200,
    });
  }

  return checks;
}

/** Assemble the copy-pasteable `curl` for a check (placeholder token, never a real secret). */
function curlFor(check: TestCheck): string {
  const url = `${API_BASE_URL}${check.path}`;
  const auth = `  -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
  if (check.method === "GET") {
    return `curl -sS ${url} \\\n${auth}`;
  }
  return [
    `curl -sS -X POST ${url} \\`,
    `  -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${check.body}'`,
  ].join("\n");
}

/**
 * Whether the in-app OpenAPI link is shown. Swagger is mounted ONLY when `NODE_ENV !== 'production'`
 * (SEC-009, `apps/api/src/main.ts`) and Caddy does not proxy `/api/docs*` publicly, so the link would
 * dangle in prod. `NODE_ENV` is statically inlined into the client bundle by Next, so this gates the
 * link to dev builds (recommendation (i) from the issue).
 */
const SHOW_OPENAPI_LINK = process.env.NODE_ENV !== "production";

/**
 * The reusable "how to test it works" panel, derived from a service account's permissions. Mounts both
 * appended to the one-time {@link SecretReveal} and from a per-row "How to test" affordance.
 */
export function TestItPanel({
  permissions,
  className,
}: {
  permissions: readonly Permission[];
  className?: string;
}) {
  const t = useTranslations("settings");
  const checks = deriveTestChecks(permissions);
  const openApiUrl = `${API_BASE_URL}/api/docs`;

  return (
    <div className={className}>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {t("serviceAccounts.testIt.title")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("serviceAccounts.testIt.description")}
        </p>
      </div>

      {checks.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("serviceAccounts.testIt.noChecks")}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {checks.map((check) => {
            const snippet = curlFor(check);
            return (
              <section
                key={check.tier}
                className="rounded-lg border bg-muted/30 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {t(`serviceAccounts.testIt.checks.${check.tier}.label`)}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {check.method} {check.path}
                    </p>
                  </div>
                  <CopyButton
                    value={snippet}
                    label={t("serviceAccounts.testIt.copyAria", {
                      method: check.method,
                      path: check.path,
                    })}
                    toastMessage={t("serviceAccounts.testIt.copied")}
                    className="shrink-0"
                  />
                </div>
                <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed">
                  <code>{snippet}</code>
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("serviceAccounts.testIt.expect", { status: check.expect })}
                </p>
              </section>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        {t("serviceAccounts.testIt.hostNote")}
      </p>

      {SHOW_OPENAPI_LINK ? (
        <a
          href={openApiUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          <ArrowTopRightOnSquareIcon className="size-4" aria-hidden />
          {t("serviceAccounts.testIt.openApi")}
        </a>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("serviceAccounts.testIt.openApiProd")}
        </p>
      )}
    </div>
  );
}
