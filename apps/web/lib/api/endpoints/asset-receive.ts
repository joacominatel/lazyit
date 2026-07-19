import type { ReceiveAssets, ReceiveAssetsResult } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Bulk receiving (ADR-0089 Part A, #1029) — mint N assets from ONE AssetModel in a single action.
 * `POST /assets/batch/receive` is a PARTIAL-SUCCESS endpoint: the API loops the single-asset create
 * path per unit, so it returns 201 with `{ created: Asset[], failed: {index,error}[] }` even when
 * some (or all) units fail. The caller renders `failed` as a per-index reason list — a by-design
 * outcome, NOT a request error. Money (`purchaseCost`) is already in MINOR units on the wire (#954).
 */
export function receiveAssets(
  data: ReceiveAssets,
): Promise<ReceiveAssetsResult> {
  return apiFetch<ReceiveAssetsResult>("/assets/batch/receive", {
    method: "POST",
    body: data,
  });
}
