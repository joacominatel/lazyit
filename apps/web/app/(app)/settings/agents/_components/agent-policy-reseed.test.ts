import { describe, expect, test } from "bun:test";
import { reseedAction } from "./agent-policy-reseed";

/**
 * The re-seed rule for Settings → Reporting agents (#1174).
 *
 * The editor derives its form from the persisted policy and re-seeds whenever the generation it holds
 * stops matching `data.revision`. `AgentPolicyService.bumpRevision` fires on EVERY policy write at
 * EVERY scope — the instance default, a service account's layer, a single node's layer — so a write
 * this operator did not make also changes that number. Re-seeding unconditionally overwrote an
 * in-progress edit, and since this PR added an "Unsaved changes" badge and a Discard button it also
 * cleared both, so the loss rendered as an ordinary clean form: the page asserted an edit existed and
 * then quietly retracted it.
 *
 * The rule these tests pin: a revision the operator's OWN save produced still re-seeds (that is the
 * whole point of re-seeding — the fields must never drift from what the server stores), and so does
 * any revision arriving at a clean form. Only a foreign write against a DIRTY form is held back, and
 * held back means "keep the edit and say so", never "silently drop it".
 *
 * `savedRevision` is the revision this editor's own last successful PUT returned. It is the only
 * evidence available that distinguishes "I just saved" from "someone else wrote"; the payload carries
 * no author.
 */
describe("reseedAction", () => {
  test("first load seeds — there is nothing to lose yet", () => {
    expect(
      reseedAction({
        incomingRevision: 7,
        seededRevision: null,
        dirty: false,
        savedRevision: undefined,
      }),
    ).toBe("seed");
  });

  test("a refetch that returns the seeded generation does nothing", () => {
    expect(
      reseedAction({
        incomingRevision: 7,
        seededRevision: 7,
        dirty: true,
        savedRevision: undefined,
      }),
    ).toBe("idle");
  });

  test("a new generation seeds a clean form — no edit is at stake", () => {
    expect(
      reseedAction({
        incomingRevision: 8,
        seededRevision: 7,
        dirty: false,
        savedRevision: undefined,
      }),
    ).toBe("seed");
  });

  test("the operator's own save seeds, dirty or not — the form must track what was stored", () => {
    expect(
      reseedAction({
        incomingRevision: 8,
        seededRevision: 7,
        dirty: true,
        savedRevision: 8,
      }),
    ).toBe("seed");
  });

  test("a write nobody made here does NOT overwrite an in-progress edit", () => {
    expect(
      reseedAction({
        incomingRevision: 8,
        seededRevision: 7,
        dirty: true,
        savedRevision: undefined,
      }),
    ).toBe("conflict");
  });

  test("a write that lands AFTER this editor's own save is still foreign", () => {
    // Saved v8 here, then a service-account or per-node write bumped it to v9 while the operator was
    // already editing again. `savedRevision` is stale evidence, not a licence to overwrite.
    expect(
      reseedAction({
        incomingRevision: 9,
        seededRevision: 8,
        dirty: true,
        savedRevision: 8,
      }),
    ).toBe("conflict");
  });

  test("discarding the edit clears the conflict — the same input, now clean, seeds", () => {
    expect(
      reseedAction({
        incomingRevision: 8,
        seededRevision: 7,
        dirty: false,
        savedRevision: undefined,
      }),
    ).toBe("seed");
  });
});
