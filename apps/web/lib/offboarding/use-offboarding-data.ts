"use client";

import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import { useMemo } from "react";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useAssets } from "@/lib/api/hooks/use-assets";
import {
  useUserAssignments,
  useUserGrants,
} from "@/lib/api/hooks/use-users";

/**
 * Resolves everything the Offboarding Sheet AND the printable Return Act need for one user, from the
 * same client-side catalog reads — so the two surfaces are guaranteed to agree on what is released
 * and revoked (no second source of truth, no backend manifest endpoint for v1).
 *
 * Why client-side resolution: the per-user assignment/grant reads are deliberately lean (FK ids
 * only). We resolve the labels against the asset catalog (`GET /assets` already returns the trimmed
 * `model` + `category` inline) and the application directory. The catalog is capped at the hard-max
 * page (~200); an asset/app beyond that cap — or one soft-deleted out of the catalog — won't resolve,
 * and we surface its raw id with `resolved: false` rather than crashing or inventing a label.
 */

/** One asset to be returned, resolved (or partially resolved) for display. */
export interface OffboardAssetRow {
  /** The assignment id (stable React key). */
  assignmentId: string;
  /** The asset id — always present, shown raw when the asset can't be resolved. */
  assetId: string;
  /** False when the asset wasn't in the catalog page (>200, or soft-deleted): show the raw id. */
  resolved: boolean;
  name: string | null;
  serial: string | null;
  assetTag: string | null;
  /** "Manufacturer Model" when both are known, else whichever is present, else null. */
  model: string | null;
  category: string | null;
  status: string | null;
}

/** One access grant to be revoked, resolved for display. */
export interface OffboardGrantRow {
  /** The grant id (stable React key). */
  grantId: string;
  applicationId: string;
  resolved: boolean;
  appName: string | null;
  accessLevel: string | null;
  /** ISO string or null — informational only (no scheduler auto-revokes at expiry). */
  expiresAt: string | null;
  isCritical: boolean;
}

export interface OffboardingData {
  assets: OffboardAssetRow[];
  grants: OffboardGrantRow[];
  /** True while any of the underlying reads are still loading — drive skeletons off this. */
  isLoading: boolean;
  /**
   * True when ANY of the four underlying reads failed. Critical: a failed read collapses `assets`/
   * `grants` to empty (`data ?? []`), so without this flag a fetch error is indistinguishable from
   * "user holds nothing" — and the Return Act would under-report. Surfaces MUST render an explicit
   * error state (never `isEmpty`) when this is true and must NOT present an act built from partial
   * data. See issue #601.
   */
  isError: boolean;
  /**
   * True ONLY when every read succeeded and the user genuinely holds nothing to return and has no
   * access to revoke. Never true while loading or on error.
   */
  isEmpty: boolean;
  /** Refetch all four underlying reads — wire to a "retry" control in the error state. */
  refetch: () => void;
}

/** Join an AssetModel's manufacturer + name into a single display string. */
function modelLabel(
  manufacturer: string | undefined,
  name: string | undefined,
): string | null {
  const parts = [manufacturer, name].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Resolve the active assignments + active grants for `userId` into display rows. `enabled` gates the
 * per-user reads (the catalog reads are cheap and shared app-wide, so they always run).
 */
export function useOffboardingData(
  userId: string | undefined,
  enabled = true,
): OffboardingData {
  const assignmentsQuery = useUserAssignments(enabled ? userId : undefined, false);
  const grantsQuery = useUserGrants(enabled ? userId : undefined, false);
  const assetsQuery = useAssets({ limit: MAX_PAGE_LIMIT });
  const applicationsQuery = useApplications();

  const assetById = useMemo(
    () => new Map((assetsQuery.data?.items ?? []).map((a) => [a.id, a])),
    [assetsQuery.data],
  );
  const appById = useMemo(
    () => new Map((applicationsQuery.data ?? []).map((a) => [a.id, a])),
    [applicationsQuery.data],
  );

  const assets = useMemo<OffboardAssetRow[]>(() => {
    const active = (assignmentsQuery.data ?? []).filter(
      (a) => a.releasedAt === null,
    );
    return active.map((assignment) => {
      const asset = assetById.get(assignment.assetId);
      if (!asset) {
        return {
          assignmentId: assignment.id,
          assetId: assignment.assetId,
          resolved: false,
          name: null,
          serial: null,
          assetTag: null,
          model: null,
          category: null,
          status: null,
        };
      }
      return {
        assignmentId: assignment.id,
        assetId: assignment.assetId,
        resolved: true,
        name: asset.name,
        serial: asset.serial,
        assetTag: asset.assetTag,
        model: modelLabel(asset.model?.manufacturer, asset.model?.name),
        category: asset.model?.category?.name ?? null,
        status: asset.status,
      };
    });
  }, [assignmentsQuery.data, assetById]);

  const grants = useMemo<OffboardGrantRow[]>(() => {
    const active = (grantsQuery.data ?? []).filter((g) => g.revokedAt === null);
    return active.map((grant) => {
      const app = appById.get(grant.applicationId);
      return {
        grantId: grant.id,
        applicationId: grant.applicationId,
        resolved: Boolean(app),
        appName: app?.name ?? null,
        accessLevel: grant.accessLevel,
        expiresAt: grant.expiresAt,
        isCritical: app?.isCritical ?? false,
      };
    });
  }, [grantsQuery.data, appById]);

  const isLoading =
    assignmentsQuery.isLoading ||
    grantsQuery.isLoading ||
    assetsQuery.isLoading ||
    applicationsQuery.isLoading;

  // Any failed read makes the resolved lists untrustworthy (they silently collapse to empty), so a
  // single failure poisons the whole view — better to refuse than to under-report on a compliance act.
  const isError =
    assignmentsQuery.isError ||
    grantsQuery.isError ||
    assetsQuery.isError ||
    applicationsQuery.isError;

  const refetch = () => {
    void assignmentsQuery.refetch();
    void grantsQuery.refetch();
    void assetsQuery.refetch();
    void applicationsQuery.refetch();
  };

  return {
    assets,
    grants,
    isLoading,
    isError,
    // Genuinely-empty requires success: never conflate a failed read with "nothing to return".
    isEmpty:
      !isLoading && !isError && assets.length === 0 && grants.length === 0,
    refetch,
  };
}
