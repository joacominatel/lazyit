import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Post-process the OpenAPI document to document the standard error contract (ADR-0018) once,
 * globally, instead of decorating every handler. Adds:
 *
 *   1. an `ApiError` component schema (the shared envelope: { statusCode, message, error? }), and
 *   2. a default per-status error response on every operation, referencing that schema — but only
 *      for statuses an operation does not already declare (so an explicit @ApiConflictResponse,
 *      etc. is never clobbered).
 *
 * Run AFTER nestjs-zod's cleanupOpenApiDoc so the schema additions survive the cleanup pass.
 */

const API_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    statusCode: { type: 'integer', example: 400 },
    message: {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    error: { type: 'string' },
  },
  required: ['statusCode', 'message'],
} as const;

// The standard error statuses every authenticated endpoint can return. 400 (validation / malformed
// query), 401 (missing/invalid token), 403 (RolesGuard), 404 (missing record), 409 (conflict),
// 500 (unexpected fault). Methods without a body (GET) can still 400 on a bad query param.
const STANDARD_ERRORS: Record<string, string> = {
  '400': 'Bad Request — validation or malformed query/parameter',
  '401': 'Unauthorized — missing or invalid Bearer token',
  '403': 'Forbidden — the role is not permitted (RolesGuard)',
  '404': 'Not Found — the record does not exist',
  '409': 'Conflict — the operation conflicts with current state',
  '500': 'Internal Server Error',
};

function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ApiError' },
      },
    },
  };
}

export function addStandardErrorResponses(doc: OpenAPIObject): OpenAPIObject {
  doc.components = doc.components ?? {};
  doc.components.schemas = doc.components.schemas ?? {};
  // Register the shared error envelope as a reusable component (idempotent).
  doc.components.schemas.ApiError = API_ERROR_SCHEMA as unknown as Record<
    string,
    unknown
  >;

  const methods = ['get', 'post', 'patch', 'put', 'delete'] as const;
  for (const path of Object.values(doc.paths ?? {})) {
    for (const method of methods) {
      const operation = path[method];
      if (!operation) continue;
      operation.responses = operation.responses ?? {};
      for (const [status, description] of Object.entries(STANDARD_ERRORS)) {
        // Never overwrite a response the handler already declared (e.g. @ApiConflictResponse).
        if (operation.responses[status] === undefined) {
          operation.responses[status] = errorResponse(description);
        }
      }
    }
  }
  return doc;
}
