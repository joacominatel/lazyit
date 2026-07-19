import type {
  AcknowledgeAssignment,
  AssetAssignment,
  CreateAssetAssignment,
  ReleaseAssetAssignment,
  UpdateAssetAssignmentNotes,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Write-access for AssetAssignments — the timestamped ownership join (append-only
 * with a release marker, ADR-0019). Reads of an asset's assignments live in
 * endpoints/assets.ts (`getAssetAssignments`, the nested route).
 */

const BASE = "/asset-assignments";

/** Open an assignment: assign a user to an asset. */
export function createAssetAssignment(
  data: CreateAssetAssignment,
): Promise<AssetAssignment> {
  return apiFetch<AssetAssignment>(BASE, { method: "POST", body: data });
}

/** Release an active assignment (sets releasedAt). 409 if already released. */
export function releaseAssetAssignment(
  id: string,
  data: ReleaseAssetAssignment = {},
): Promise<AssetAssignment> {
  return apiFetch<AssetAssignment>(`${BASE}/${id}/release`, {
    method: "PATCH",
    body: data,
  });
}

/** Update only the notes of an assignment (`null` clears them). */
export function updateAssetAssignmentNotes(
  id: string,
  data: UpdateAssetAssignmentNotes,
): Promise<AssetAssignment> {
  return apiFetch<AssetAssignment>(`${BASE}/${id}/notes`, {
    method: "PATCH",
    body: data,
  });
}

/**
 * Acknowledge receipt of an asset checked out to you (ADR-0089 Part B, #1029). SELF-SERVICE — the API
 * scopes the transition to the caller's OWN active assignment (the actor comes from the principal,
 * never the body). Set-once: acknowledging an already-acknowledged / released / not-your assignment
 * returns 409. Only an optional `note` is carried.
 */
export function acknowledgeAssetAssignment(
  id: string,
  data: AcknowledgeAssignment = {},
): Promise<AssetAssignment> {
  return apiFetch<AssetAssignment>(`${BASE}/${id}/acknowledge`, {
    method: "POST",
    body: data,
  });
}
