import type {
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
