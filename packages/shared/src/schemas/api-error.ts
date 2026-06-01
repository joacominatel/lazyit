import { z } from "zod";

/**
 * The standard API error envelope (ADR-0018) — the wire shape NestJS's exception layer emits for an
 * HttpException, and that the PrismaExceptionFilter / AllExceptionsFilter map onto (ADR-0031). One
 * shared definition so the OpenAPI doc (`ApiErrorDto` via createZodDto) and any web-side error
 * handling agree on the same shape instead of each guessing it.
 *
 * Fields mirror Nest's default response body:
 *   - `statusCode` — the HTTP status (e.g. 400, 404, 409).
 *   - `message`    — a human-readable message, or an array of messages (validation can return many).
 *   - `error`      — the status reason phrase (e.g. "Bad Request"); optional (Nest omits it for some
 *                    HttpException constructions).
 *
 * NOTE: the `X-Request-Id` correlation id (ADR-0031) travels in the response HEADER, not this body;
 * the web client reads it from there. It is intentionally not a field here.
 */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
