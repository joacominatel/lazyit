import { expect, mock, test } from "bun:test";
import { assetTagSchemeKeys } from "./query-keys";

/**
 * Regression guard for #1180 — the two ways the tag preview can go back to lying WITHOUT anything
 * throwing, now that the number itself is chosen server-side.
 *
 * The defect being fixed was a preview that rendered the raw counter while the allocator skipped past
 * it (`LZ-1000` shown, `LZ-1001` allocated). Moving the choice to `GET .../next-tag` fixes it only if
 * the request carries the pattern the operator is actually looking at. Two silent regressions would
 * restore the old symptom exactly — a confident, plausible, wrong tag:
 *
 *   1. **A dropped `from`.** The editor previews an UNSAVED `startNumber` by sending it as the counter
 *      floor. If the query-string builder drops it, the server silently falls back to the STORED
 *      counter and answers a different question than the one on screen. Nothing errors.
 *   2. **A floor-blind cache key.** The preview for floor 1000 and the preview for floor 2000 are
 *      different answers. If they share a TanStack key, the cache serves one for the other.
 *
 * Both are asserted by EXECUTING the real code (the URL is built and read back, the keys are built and
 * compared) rather than by matching a pattern that would also be present on a broken build.
 */

// The endpoint module's only side effect is `apiFetch`; capture the URL it is handed.
const calls: string[] = [];
void mock.module("./client", () => ({
  apiFetch: (path: string) => {
    calls.push(path);
    return Promise.resolve({
      fromNumber: 1000,
      number: 1001,
      tag: "IT#1001",
      skippedCount: 1,
      exhausted: false,
    });
  },
}));

const { getAssetTagNextPreview } = await import("./endpoints/asset-tag-scheme");

/** The querystring of the last request, parsed — so assertions read parameters, not substrings. */
async function requestParams(
  params: Parameters<typeof getAssetTagNextPreview>[0],
): Promise<URLSearchParams> {
  calls.length = 0;
  await getAssetTagNextPreview(params);
  expect(calls).toHaveLength(1);
  const [path, search] = calls[0]!.split("?");
  expect(path).toBe("/config/asset-tag-scheme/next-tag");
  return new URLSearchParams(search ?? "");
}

test("the unsaved startNumber travels as `from` — the floor the preview is showing", async () => {
  const qs = await requestParams({ prefix: "IT#", width: 4, from: 2000 });

  expect(qs.get("from")).toBe("2000");
  expect(qs.get("prefix")).toBe("IT#");
  expect(qs.get("width")).toBe("4");
});

test("`from: 0` is sent, not swallowed as falsy (0 is a valid counter floor)", async () => {
  // `if (params.from)` instead of `!== undefined` would drop this and preview the stored counter.
  const qs = await requestParams({ from: 0 });

  expect(qs.get("from")).toBe("0");
});

test("an omitted `from` sends no floor, so the server uses the stored counter", async () => {
  const qs = await requestParams({ prefix: "IT#" });

  expect(qs.has("from")).toBe(false);
});

test("an empty pattern requests the bare route (no stray `?`)", async () => {
  calls.length = 0;
  await getAssetTagNextPreview({});

  expect(calls).toEqual(["/config/asset-tag-scheme/next-tag"]);
});

test("two counter floors are two cache entries — one preview is never served for the other", () => {
  const atThousand = assetTagSchemeKeys.nextPreview({ prefix: "IT#", from: 1000 });
  const atTwoThousand = assetTagSchemeKeys.nextPreview({ prefix: "IT#", from: 2000 });

  expect(atThousand).not.toEqual(atTwoThousand);
});

test("two patterns at the same floor are two cache entries", () => {
  const it = assetTagSchemeKeys.nextPreview({ prefix: "IT#", from: 1000 });
  const lab = assetTagSchemeKeys.nextPreview({ prefix: "LAB-", from: 1000 });

  expect(it).not.toEqual(lab);
});

test("the preview key sits under the scheme prefix, so saving the scheme invalidates it", () => {
  // `useUpdateAssetTagScheme` invalidates `assetTagSchemeKeys.all`; TanStack matches by prefix, so a
  // preview key that did not start with it would survive a save and keep showing the old pattern.
  const key = assetTagSchemeKeys.nextPreview({ prefix: "IT#", from: 1000 });

  expect(key.slice(0, assetTagSchemeKeys.all.length)).toEqual([
    ...assetTagSchemeKeys.all,
  ]);
});
