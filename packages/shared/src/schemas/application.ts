import { z } from "zod";
import { optionalText, requireAtLeastOneKey } from "./primitives";

/**
 * Application — something a User can be granted access to: a SaaS product (Jira, GitHub, AWS), an
 * internal system, or a technical service (VPN, AD group). The catalog of access targets. Single
 * source of truth for api and web. See docs/02-domain/entities/application.md and
 * docs/03-decisions/0023-access-management-design.md.
 *
 * Date fields are ISO-8601 strings (the wire shape) — see the note in application-category.ts.
 */

// TODO(metadata): once applications need typed extras (ssoProvider, ownerTeam, externalIds, …),
// validate this against a real schema. For now any JSON object is accepted — same debt as
// Asset.specs / Article.metadata. See docs/03-decisions/0007-flexible-asset-specs-jsonb.md.
const ApplicationMetadataSchema = z.record(z.string(), z.unknown());

/**
 * `url` is stored as a free string, not strictly URL-validated: internal IT targets are often
 * scheme-less hosts (e.g. `vpn.corp.local`) that `z.url()` would reject. Kept lenient on purpose —
 * but a value later rendered as a link href must not carry an executable scheme (SEC-008): a
 * `javascript:` / `data:` url would be a stored XSS sink. So the leniency stays (scheme-less hosts,
 * with or without a port, and http(s) urls) while any other scheme is rejected.
 */

/**
 * True when `value` is safe to store as an `Application.url`: a scheme-less host/path (including
 * `host:port`) or an `http`/`https` url. Any other scheme — notably `javascript:`, `data:`,
 * `vbscript:`, `file:` — is rejected. Robust to whitespace/control-char obfuscation: TAB/LF/CR are
 * stripped anywhere and any leading non-alphanumeric run is dropped (browsers ignore leading control
 * chars and strip TAB/LF/CR before parsing the scheme), so `java\tscript:` and a leading control
 * byte can't hide the scheme. Render-time code should additionally allow-list the href scheme.
 */
export function isSafeApplicationUrl(value: string): boolean {
  const normalized = value
    .replace(/[\t\n\r]/g, "")
    .replace(/^[^a-zA-Z0-9]+/, "");
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
  if (!match) return true; // scheme-less host/path, e.g. vpn.corp.local
  const scheme = match[1].toLowerCase();
  if (scheme === "http" || scheme === "https") return true;
  // A scheme-less host with a port (vpn.corp.local:8080) is read as scheme=host by the regex above;
  // allow it when what follows the first colon is only a port (+ optional path).
  const afterColon = normalized.slice(match[0].length);
  return /^\d+(\/.*)?$/.test(afterColon);
}

const ApplicationUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isSafeApplicationUrl, {
    message:
      "url must be a scheme-less host or use http(s); javascript:, data:, vbscript: and file: are not allowed",
  });

/** The full persisted Application entity (API representation of the `applications` row). */
export const ApplicationSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  url: z.string().nullable(),
  vendor: z.string().nullable(),
  categoryId: z.cuid().nullable(),
  isCritical: z.boolean(),
  metadata: ApplicationMetadataSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create an Application. Only `name` is required; `isCritical` defaults to false. */
export const CreateApplicationSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000).optional(),
  url: ApplicationUrlSchema.optional(),
  vendor: z.string().trim().min(1).max(200).optional(),
  categoryId: z.cuid().optional(),
  isCritical: z.boolean().default(false),
  metadata: ApplicationMetadataSchema.optional(),
  notes: optionalText(2000),
});

/** Partial update; any subset of the editable fields (an empty body is rejected). */
export const UpdateApplicationSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(2000),
      url: ApplicationUrlSchema,
      vendor: z.string().trim().min(1).max(200),
      categoryId: z.cuid(),
      isCritical: z.boolean(),
      metadata: ApplicationMetadataSchema,
      notes: z.string().trim().min(1).max(2000),
    })
    .partial(),
);

export type Application = z.infer<typeof ApplicationSchema>;
export type CreateApplication = z.infer<typeof CreateApplicationSchema>;
export type UpdateApplication = z.infer<typeof UpdateApplicationSchema>;
