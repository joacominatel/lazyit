import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { folderMutationErrorKind } from "./folder-mutation-error";

/**
 * The folder create/rename/move dialogs must turn the API's three rejections into three distinct
 * sentences instead of one generic toast (#1291). The messages asserted here are the verbatim ones
 * `ArticleCategoriesService` raises, so a wording drift on the server that this classifier stops
 * recognising shows up as a failing test rather than as a silently generic toast.
 */

describe("folderMutationErrorKind", () => {
  test("409 is the per-parent duplicate name", () => {
    // The PrismaExceptionFilter's P2002 mapping — the only source of a 409 on these endpoints.
    expect(
      folderMutationErrorKind(
        new ApiError(409, "A record with this parentId, name already exists"),
      ),
    ).toBe("duplicateName");
  });

  test("the DFS cycle guard's 400 is a cycle", () => {
    expect(
      folderMutationErrorKind(
        new ApiError(400, "Moving this folder there would create a folder cycle"),
      ),
    ).toBe("cycle");
  });

  test("the self-parent short-circuit's 400 is a cycle too", () => {
    expect(
      folderMutationErrorKind(new ApiError(400, "A folder cannot be its own parent")),
    ).toBe("cycle");
  });

  test("a parent that is not a live folder is a dead parent", () => {
    expect(
      folderMutationErrorKind(
        new ApiError(400, "parentId abc123 does not reference a live folder"),
      ),
    ).toBe("deadParent");
  });

  test("an unrecognised 400 falls back to the server's own message", () => {
    expect(folderMutationErrorKind(new ApiError(400, "name must be shorter"))).toBeNull();
  });

  test("403 is a move without settings:manage (AUD-001)", () => {
    expect(
      folderMutationErrorKind(
        new ApiError(
          403,
          "Moving a folder changes who can read its articles and requires the settings:manage permission",
        ),
      ),
    ).toBe("moveForbidden");
  });

  test("other statuses are not classified", () => {
    expect(folderMutationErrorKind(new ApiError(404, "Record not found"))).toBeNull();
    expect(folderMutationErrorKind(new ApiError(500, "cycle"))).toBeNull();
  });

  test("a non-API failure (network, thrown value) is not classified", () => {
    expect(folderMutationErrorKind(new Error("Failed to fetch"))).toBeNull();
    expect(folderMutationErrorKind(undefined)).toBeNull();
    expect(folderMutationErrorKind({ status: 409 })).toBeNull();
  });
});
