import { z } from "zod";
import { GrantProvisioningSchema } from "./access-grant";
import { AccessRequestSchema } from "./access-request";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /access-requests` envelope:
 * `{ items: AccessRequest[], total, limit, offset }`. Offset pagination per ADR-0030 — never a bare
 * array. Newest-first. The item is the full {@link AccessRequestSchema} (no relations are inlined on
 * the list), so only the page envelope is added.
 */
export const AccessRequestListPageSchema = pageSchema(AccessRequestSchema);

export type AccessRequestListPage = z.infer<typeof AccessRequestListPageSchema>;

/**
 * A request as the self-scope `GET /access-requests/mine` returns it (#1700): the full
 * {@link AccessRequestSchema} plus the coarse `provisioning` status of the grant an approval created,
 * while that grant is still active. `null` when there is nothing to show (PENDING, DENIED, or the
 * grant was revoked since). Tolerant on read: absent from an API that predates it, and a value a newer
 * API adds reads as absent (`.catch`) instead of failing the whole list. The estate-wide
 * `GET /access-requests` does not carry it.
 */
export const MyAccessRequestSchema = AccessRequestSchema.extend({
  provisioning: GrantProvisioningSchema.nullable().optional().catch(undefined),
});
export type MyAccessRequest = z.infer<typeof MyAccessRequestSchema>;

/** Paginated self-scope `GET /access-requests/mine` envelope (#1700). */
export const MyAccessRequestListPageSchema = pageSchema(MyAccessRequestSchema);

export type MyAccessRequestListPage = z.infer<
  typeof MyAccessRequestListPageSchema
>;
