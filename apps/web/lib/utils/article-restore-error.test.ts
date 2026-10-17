import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { articleRestoreErrorKind } from "./article-restore-error";

describe("articleRestoreErrorKind", () => {
  test("a 409 is the slug taken while the article was archived", () => {
    const error = new ApiError(409, "A record with this slug already exists", undefined);
    expect(articleRestoreErrorKind(error)).toBe("slugTaken");
  });

  test("any other failure falls back to the generic toast", () => {
    expect(articleRestoreErrorKind(new ApiError(403, "Forbidden", undefined))).toBeNull();
    expect(articleRestoreErrorKind(new ApiError(404, "Not found", undefined))).toBeNull();
    expect(articleRestoreErrorKind(new Error("network"))).toBeNull();
  });
});
