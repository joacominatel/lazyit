import { describe, expect, test } from "bun:test";
import {
  classifyArticleMove,
  classifyFolderMove,
  type FolderAccessShape,
  needsMoveConfirmation,
} from "./kb-move-audience";

/**
 * The single verdict behind every KB move confirmation (ADR-0060 §9, #1529). Pure over the flat
 * folder list, so it is tested directly with no DOM.
 */

function folder(
  id: string,
  parentId: string | null,
  hasAccessRules: boolean | undefined,
): FolderAccessShape {
  return hasAccessRules === undefined
    ? { id, parentId }
    : { id, parentId, hasAccessRules };
}

// public/                 (root, public)
//   public-child/         (public)
// secure/                 (root, RESTRICTED)
//   secure-child/         (public itself, inherits secure)
//     secure-grandchild/  (public itself, inherits secure)
//   secure-narrow/        (RESTRICTED, under secure)
// vault/                  (root, RESTRICTED)
//   vault-child/          (public itself, inherits vault)
// legacy/                 (root, no flag — an older server)
//   legacy-child/         (public, but its parent's flag is missing)
const FOLDERS: FolderAccessShape[] = [
  folder("public", null, false),
  folder("public-child", "public", false),
  folder("secure", null, true),
  folder("secure-child", "secure", false),
  folder("secure-grandchild", "secure-child", false),
  folder("secure-narrow", "secure", true),
  folder("vault", null, true),
  folder("vault-child", "vault", false),
  folder("legacy", null, undefined),
  folder("legacy-child", "legacy", false),
];

describe("classifyArticleMove", () => {
  test("no actual folder change is never a move", () => {
    expect(classifyArticleMove("secure", "secure", FOLDERS)).toBe("none");
    // Not even when the flag is missing — there is nothing to confirm.
    expect(classifyArticleMove("legacy", "legacy", FOLDERS)).toBe("none");
  });

  test("public → public needs nothing", () => {
    expect(classifyArticleMove("public", "public-child", FOLDERS)).toBe("none");
  });

  test("public → restricted only narrows, so needs nothing", () => {
    expect(classifyArticleMove("public", "secure", FOLDERS)).toBe("none");
    expect(classifyArticleMove("public-child", "secure-grandchild", FOLDERS)).toBe(
      "none",
    );
  });

  test("restricted → public widens to everyone", () => {
    expect(classifyArticleMove("secure", "public", FOLDERS)).toBe(
      "widens-to-public",
    );
  });

  test("a restriction inherited from an ancestor counts as restricted", () => {
    // secure-grandchild has no rule of its own; its grandparent restricts it.
    expect(classifyArticleMove("secure-grandchild", "public-child", FOLDERS)).toBe(
      "widens-to-public",
    );
  });

  test("restricted → a folder restricted by other folders changes the audience", () => {
    expect(classifyArticleMove("secure", "vault", FOLDERS)).toBe(
      "changes-restriction",
    );
    expect(classifyArticleMove("secure-child", "vault-child", FOLDERS)).toBe(
      "changes-restriction",
    );
  });

  test("moving out of a narrower sub-folder to its restricted parent changes the audience", () => {
    // {secure, secure-narrow} → {secure}: dropping one rule may let more people in.
    expect(classifyArticleMove("secure-narrow", "secure-child", FOLDERS)).toBe(
      "changes-restriction",
    );
  });

  test("a different restricted set is confirmed even when it only adds a folder", () => {
    // {secure} → {secure, secure-narrow}. One bit per folder cannot tell the user which way an
    // audience moves in general, so every different set is confirmed alike.
    expect(classifyArticleMove("secure-child", "secure-narrow", FOLDERS)).toBe(
      "changes-restriction",
    );
  });

  test("the same restricting chain on both sides needs nothing", () => {
    // Both sit under `secure` alone.
    expect(classifyArticleMove("secure", "secure-grandchild", FOLDERS)).toBe(
      "none",
    );
    expect(classifyArticleMove("secure-child", "secure-grandchild", FOLDERS)).toBe(
      "none",
    );
  });

  test("a missing flag anywhere on either path is unknown, never safe", () => {
    expect(classifyArticleMove("legacy", "public", FOLDERS)).toBe("unknown");
    expect(classifyArticleMove("secure", "legacy", FOLDERS)).toBe("unknown");
    // The destination itself carries `false`, but its parent's flag is missing.
    expect(classifyArticleMove("secure", "legacy-child", FOLDERS)).toBe(
      "unknown",
    );
  });

  test("an unknown folder id is unknown", () => {
    expect(classifyArticleMove("secure", "ghost", FOLDERS)).toBe("unknown");
    expect(classifyArticleMove("ghost", "public", FOLDERS)).toBe("unknown");
    expect(classifyArticleMove("secure", "public", [])).toBe("unknown");
  });

  test("a missing (soft-deleted) ancestor is unknown", () => {
    const orphaned = [
      folder("orphan", "deleted-parent", false),
      folder("public", null, false),
    ];
    expect(classifyArticleMove("orphan", "public", orphaned)).toBe("unknown");
  });

  test("a malformed parentId cycle terminates", () => {
    const cyclic = [
      folder("a", "b", true),
      folder("b", "a", false),
      folder("public", null, false),
    ];
    expect(classifyArticleMove("b", "public", cyclic)).toBe("widens-to-public");
  });
});

describe("classifyFolderMove", () => {
  test("re-parenting to the same parent is not a move", () => {
    expect(classifyFolderMove("secure-child", "secure", FOLDERS)).toBe("none");
    expect(classifyFolderMove("public", null, FOLDERS)).toBe("none");
  });

  test("a public folder moving under a restricted one only narrows", () => {
    expect(classifyFolderMove("public-child", "secure", FOLDERS)).toBe("none");
  });

  test("pulling a folder that inherits a restriction out to the top level widens to everyone", () => {
    expect(classifyFolderMove("secure-child", null, FOLDERS)).toBe(
      "widens-to-public",
    );
    expect(classifyFolderMove("secure-child", "public", FOLDERS)).toBe(
      "widens-to-public",
    );
  });

  test("a folder with its own rule pulled out of a restricted parent changes the audience", () => {
    // {secure, secure-narrow} → {secure-narrow}: still restricted, by fewer folders.
    expect(classifyFolderMove("secure-narrow", null, FOLDERS)).toBe(
      "changes-restriction",
    );
  });

  test("moving between differently restricted parents changes the audience", () => {
    expect(classifyFolderMove("secure-child", "vault", FOLDERS)).toBe(
      "changes-restriction",
    );
  });

  test("moving within the same restricted chain needs nothing", () => {
    // secure-grandchild: {secure} → under secure directly, still {secure}.
    expect(classifyFolderMove("secure-grandchild", "secure", FOLDERS)).toBe(
      "none",
    );
  });

  test("a destination inside the folder's own subtree is left to the API's cycle refusal", () => {
    expect(classifyFolderMove("secure", "secure-grandchild", FOLDERS)).toBe(
      "none",
    );
  });

  test("a missing flag on the folder, its path or the destination's path is unknown", () => {
    expect(classifyFolderMove("legacy-child", null, FOLDERS)).toBe("unknown");
    expect(classifyFolderMove("secure-child", "legacy", FOLDERS)).toBe(
      "unknown",
    );
    expect(classifyFolderMove("legacy", "public", FOLDERS)).toBe("unknown");
  });

  test("an unknown folder or destination id is unknown", () => {
    expect(classifyFolderMove("ghost", null, FOLDERS)).toBe("unknown");
    expect(classifyFolderMove("secure-child", "ghost", FOLDERS)).toBe(
      "unknown",
    );
  });
});

describe("needsMoveConfirmation", () => {
  test("only the two audience-changing verdicts ask first", () => {
    expect(needsMoveConfirmation("widens-to-public")).toBe(true);
    expect(needsMoveConfirmation("changes-restriction")).toBe(true);
    expect(needsMoveConfirmation("none")).toBe(false);
    expect(needsMoveConfirmation("unknown")).toBe(false);
  });
});
