import type {
  AccessGrant,
  Application,
  CreateApplication,
  Page,
  UpdateApplication,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for Application — the access catalog (ADR-0023). Standard CRUD via the factory; the
 * list and detail are **raw** (no expanded read), so the Access screen joins category + grants
 * client-side. Plus the nested read for one application's grants.
 */

const BASE = "/applications";

const crud = createCrudEndpoints<Application, CreateApplication, UpdateApplication>(
  BASE,
);
// `GET /applications` is paginated (ADR-0030 amendment): unwrap the
// `Page<Application>` envelope to its `items` for the current array-based Access
// screen. The list-chain wave will consume the full envelope + server-side params.
export const getApplications = (): Promise<Application[]> =>
  apiFetch<Page<Application>>(BASE).then((page) => page.items);
export const getApplication = crud.get;
export const createApplication = crud.create;
export const updateApplication = crud.update;
export const deleteApplication = crud.remove;

export interface ApplicationGrantsOptions {
  /** Default true — only active (non-revoked) grants. Pass false for the full history. */
  activeOnly?: boolean;
  /** Default true — include active grants past their expiresAt. Pass false to hide them. */
  includeExpired?: boolean;
}

/** One application's access grants (raw — `userId` only; resolve the user client-side). */
export function getApplicationGrants(
  applicationId: string,
  { activeOnly, includeExpired }: ApplicationGrantsOptions = {},
): Promise<AccessGrant[]> {
  const params = new URLSearchParams();
  if (activeOnly !== undefined) params.set("activeOnly", String(activeOnly));
  if (includeExpired !== undefined)
    params.set("includeExpired", String(includeExpired));
  const qs = params.toString();
  return apiFetch<AccessGrant[]>(
    qs
      ? `${BASE}/${applicationId}/access-grants?${qs}`
      : `${BASE}/${applicationId}/access-grants`,
  );
}
