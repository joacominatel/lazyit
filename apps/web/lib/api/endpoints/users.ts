import type { CreateUser, UpdateUser, User } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the User resource. This is the ONLY place that
 * talks to `apiFetch` for users — hooks (../hooks) wrap these in TanStack Query,
 * and pages/components consume the hooks. Nothing calls `fetch` (or `apiFetch`)
 * directly. Mirrors endpoints/locations.ts — the data-layer template (ADR-0020).
 *
 * Routes mirror apps/api/src/users (see the User entity note + ADR-0018).
 * Timestamps come back as ISO strings, not `Date` instances.
 */

const BASE = "/users";

export function getUsers(): Promise<User[]> {
  return apiFetch<User[]>(BASE);
}

export function getUser(id: string): Promise<User> {
  return apiFetch<User>(`${BASE}/${id}`);
}

export function createUser(data: CreateUser): Promise<User> {
  return apiFetch<User>(BASE, { method: "POST", body: data });
}

export function updateUser(id: string, data: UpdateUser): Promise<User> {
  return apiFetch<User>(`${BASE}/${id}`, { method: "PATCH", body: data });
}

export function deleteUser(id: string): Promise<User> {
  // Soft delete on the backend; returns the now-archived record.
  return apiFetch<User>(`${BASE}/${id}`, { method: "DELETE" });
}
