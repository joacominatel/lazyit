import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CreateApplicationWorkflowSchema,
  CreateWorkflowConnectionSchema,
  CreateWorkflowSecretSchema,
  CreateWorkflowVersionSchema,
  UpdateApplicationWorkflowSchema,
  WorkflowConnectionConfigSchema,
} from '@lazyit/shared';

/**
 * Definition / connection / secret DTOs for the workflow CRUD controllers (contract C1). Most reuse the
 * shared zod schemas (validation + a single OpenAPI schema name); the connection PATCH and the secret
 * ROTATE bodies have no shared schema yet (api-internal shapes), so they are defined here as strict zod
 * objects — never echoing a secret, kind immutable on a connection.
 */

// ── workflows ──
export class CreateApplicationWorkflowDto extends createZodDto(
  CreateApplicationWorkflowSchema,
) {}
export class UpdateApplicationWorkflowDto extends createZodDto(
  UpdateApplicationWorkflowSchema,
) {}
export class CreateWorkflowVersionDto extends createZodDto(
  CreateWorkflowVersionSchema,
) {}

// ── connections ──
export class CreateWorkflowConnectionDto extends createZodDto(
  CreateWorkflowConnectionSchema,
) {}

/** Patch a connection: name / per-kind config / credential reference. The `kind` is immutable. */
export const UpdateWorkflowConnectionApiSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    config: WorkflowConnectionConfigSchema.optional(),
    // A cuid reference into WorkflowSecret, or null to clear the credential. Never the secret itself.
    secretId: z.cuid().nullable().optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    'Provide at least one field to update',
  );
export class UpdateWorkflowConnectionDto extends createZodDto(
  UpdateWorkflowConnectionApiSchema,
) {}

// ── secrets (write-only) ──
export class CreateWorkflowSecretDto extends createZodDto(
  CreateWorkflowSecretSchema,
) {}

/** Rotate a secret's value in place — cleartext in once, never echoed back. */
export const RotateWorkflowSecretApiSchema = z.strictObject({
  value: z.string().min(1).max(8192),
});
export class RotateWorkflowSecretDto extends createZodDto(
  RotateWorkflowSecretApiSchema,
) {}
