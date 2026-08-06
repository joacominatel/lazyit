import { describe, expect, it } from "bun:test";
import { nodeSectionKey } from "./node-detail-keys";

const NODE = "cmxnode000000000000000000";
const SECRET = { vaultId: "vault-1", handle: "srv/root", label: "Root" };
const SHORTCUT = { label: "SSH", url: "ssh://host" };

describe("nodeSectionKey", () => {
  // The #1228 regression, and the whole reason this derivation left the JSX. `SecretsEditor` and
  // `ShortcutsEditor` are siblings in one children array; when both keys collide React loses one of
  // the old fibers in `mapRemainingChildren` and never unmounts its DOM. Attaching the first secret
  // to a node with no secrets and no shortcuts then rendered the secrets section TWICE — the stale
  // empty one plus the new one — until the modal was closed and reopened.
  describe("never collides between the two General-tab editors", () => {
    it("for a node with no secrets and no shortcuts (the reported case)", () => {
      expect(nodeSectionKey("secrets", NODE, [])).not.toBe(
        nodeSectionKey("shortcuts", NODE, null),
      );
    });

    it("for a node whose shortcuts are an empty array rather than null", () => {
      expect(nodeSectionKey("secrets", NODE, [])).not.toBe(
        nodeSectionKey("shortcuts", NODE, []),
      );
    });

    // Cheap durable guard: the collision only had to happen for ONE reachable combination, so assert
    // the whole small cross-product rather than the single case that was reported.
    it("for every combination of secrets and shortcuts a node can hold", () => {
      const secretValues = [[], [SECRET], [SECRET, SECRET]];
      const shortcutValues = [null, [], [SHORTCUT]];

      for (const secrets of secretValues) {
        for (const shortcuts of shortcutValues) {
          expect(nodeSectionKey("secrets", NODE, secrets)).not.toBe(
            nodeSectionKey("shortcuts", NODE, shortcuts),
          );
        }
      }
    });
  });

  // The key still has to do the job it was added for: a remount that re-seeds each editor's draft.
  describe("still remounts on the change it is meant to react to", () => {
    it("changes when a secret is attached", () => {
      expect(nodeSectionKey("secrets", NODE, [SECRET])).not.toBe(
        nodeSectionKey("secrets", NODE, []),
      );
    });

    it("changes when a shortcut is saved", () => {
      expect(nodeSectionKey("shortcuts", NODE, [SHORTCUT])).not.toBe(
        nodeSectionKey("shortcuts", NODE, null),
      );
    });

    // Selecting a duplicate-IP peer swaps the node in place without unmounting the modal, so the
    // node id has to stay in the key or both editors would keep the previous node's draft.
    it("changes when the detail switches to another node", () => {
      expect(nodeSectionKey("secrets", NODE, [])).not.toBe(
        nodeSectionKey("secrets", "cmxother00000000000000000", []),
      );
    });
  });

  // Attaching a secret must not blow away an in-progress shortcuts draft (and vice versa): each
  // scope only reacts to its own data.
  describe("does not remount the other editor", () => {
    it("keeps the shortcuts key stable across a secrets change", () => {
      expect(nodeSectionKey("shortcuts", NODE, [SHORTCUT])).toBe(
        nodeSectionKey("shortcuts", NODE, [SHORTCUT]),
      );
    });
  });

  // A key that churns per render remounts the editor on EVERY render, killing the combobox query
  // and every keystroke in the shortcuts draft — so this must never become `nextListKey()`, a
  // counter, or a random id.
  it("is stable for the same input across calls", () => {
    expect(nodeSectionKey("secrets", NODE, [SECRET])).toBe(
      nodeSectionKey("secrets", NODE, [SECRET]),
    );
    expect(nodeSectionKey("shortcuts", NODE, null)).toBe(
      nodeSectionKey("shortcuts", NODE, null),
    );
  });
});
