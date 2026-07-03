import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../constants/local-auth";
import { RoleSchema } from "./user";

/**
 * Local-mode login wire contract — ADR-0086 §3, AUTH_MODE=local. Shared so the API's `POST /auth/login`
 * DTO and the web Credentials provider (F2) validate ONE definition.
 */

/**
 * The login request body. `identifier` is an email OR a username (the server resolves either against the
 * LIVE-filtered user table). Both are normalized (trim + lowercase) server-side before lookup — email is
 * citext and username is stored lowercased, so a single lowercase lookup matches either. `password` is
 * bounded by {@link PASSWORD_MAX_LENGTH} so an oversized body is rejected (400) BEFORE argon2 runs.
 */
export const LoginRequestSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * The SAFE user projection returned on a successful login — only non-sensitive display/identity fields.
 * NEVER carries `passwordHash`, `sessionEpoch`, or anything authorization-bearing (the role here is
 * informational for the UI; the API always re-resolves authorization DB-first per request, INV-1).
 */
export const LoginUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  username: z.string().nullable(),
  role: RoleSchema,
});
export type LoginUser = z.infer<typeof LoginUserSchema>;

/**
 * The login response: the first-party session token (HS256 JWT) to present as a Bearer on later requests,
 * plus the safe user projection. The token carries only `sub` + `sessionEpoch` — no role/permissions.
 */
export const LoginResponseSchema = z.object({
  token: z.string().min(1),
  user: LoginUserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * `POST /users/:id/reset-password` result IN LOCAL MODE (AUTH_MODE=local, ADR-0086 §5). An admin reset
 * mints a one-time temporary password locally (there is no IdP to email a link, and no instance SMTP
 * yet), sets `mustChangePassword`, bumps the subject's `sessionEpoch` (killing their existing sessions)
 * and audits `PASSWORD_RESET_BY_ADMIN`. The plaintext is returned to the admin to hand off ONCE — it is
 * never stored in plaintext or shown again. In OIDC mode the endpoint keeps its 204 No Content shape
 * (Zitadel emails the link), so this body is local-mode only.
 */
export const AdminPasswordResetResultSchema = z.object({
  temporaryPassword: z.string().min(1),
});
export type AdminPasswordResetResult = z.infer<
  typeof AdminPasswordResetResultSchema
>;
