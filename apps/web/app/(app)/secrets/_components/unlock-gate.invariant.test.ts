import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * #452 RECOVERY-KEY-BEFORE-PERSIST regression guard (ADR-0061 §3/§4).
 *
 * The single biggest UX/security hazard in the bootstrap (and peer-reset) flow is finalizing a keypair on
 * the server BEFORE the shown-once recovery key has been displayed AND explicitly acknowledged. If the POST
 * runs first, a user can end up with a server-side keypair they can never recover (the "set my passphrase
 * but saw no recovery key" symptom). The component is structured so the keypair is minted in the browser,
 * the `RecoveryKeyModal` is shown, and the POST happens ONLY from the modal's acknowledge handler.
 *
 * apps/web has no DOM/RTL harness (frontend component tests are deferred — ADR-0012), so this is a STATIC
 * SOURCE scan in the same spirit as `lib/workflow/no-unsafe-html.test.ts`. It fails CI if a future refactor
 * moves a keypair-persisting mutation (`createKeypair.mutateAsync` / `resetKeypair.mutateAsync`) into the
 * FORM-SUBMIT handlers (`handleBootstrap` / `handleReset`) instead of the ACKNOWLEDGE handler
 * (`handleAcknowledge`) — i.e. if the POST can complete before the acknowledged modal.
 *
 * It is a fence, not a proof: it pins the ordering at the source level. Prefer TIGHTENING over loosening.
 */
const UNLOCK_GATE = resolve(import.meta.dir, "unlock-gate.tsx");

/** Extract the body of a top-level `function <name>(...) { ... }` by brace-matching from its opening `{`. */
function extractFunctionBody(source: string, name: string): string {
  const sig = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!sig) throw new Error(`function ${name} not found in unlock-gate.tsx`);
  const open = source.indexOf("{", sig.index);
  if (open === -1) throw new Error(`opening brace for ${name} not found`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces while reading ${name}`);
}

describe("UnlockGate bootstrap/reset persist the keypair ONLY after the recovery-key acknowledge (#452)", () => {
  test("the FORM-SUBMIT handlers never call a keypair-persisting mutation", async () => {
    const source = await Bun.file(UNLOCK_GATE).text();
    // The mint (`bootstrapKeypair`) must be browser-only here; the POST mutate must NOT appear in submit.
    const handleBootstrap = extractFunctionBody(source, "handleBootstrap");
    const handleReset = extractFunctionBody(source, "handleReset");

    expect(handleBootstrap.includes("createKeypair.mutateAsync")).toBe(false);
    expect(handleBootstrap.includes("resetKeypair.mutateAsync")).toBe(false);
    expect(handleReset.includes("createKeypair.mutateAsync")).toBe(false);
    expect(handleReset.includes("resetKeypair.mutateAsync")).toBe(false);

    // Belt-and-suspenders: each submit handler MUST still mint the material (so the recovery key exists to
    // show) and open the modal by setting the recovery key — without persisting.
    expect(handleBootstrap.includes("bootstrapKeypair")).toBe(true);
    expect(handleBootstrap.includes("setRecoveryKey")).toBe(true);
    expect(handleReset.includes("bootstrapKeypair")).toBe(true);
    expect(handleReset.includes("setRecoveryKey")).toBe(true);
  });

  test("the keypair-persisting POST lives inside the ACKNOWLEDGE handler", async () => {
    const source = await Bun.file(UNLOCK_GATE).text();
    // There are two `handleAcknowledge` functions (bootstrap + reset). Their union of bodies must contain
    // BOTH persist calls; each individual flow's acknowledge gates its own POST.
    const bodies: string[] = [];
    let cursor = 0;
    while (true) {
      const idx = source.indexOf("function handleAcknowledge", cursor);
      if (idx === -1) break;
      bodies.push(extractFunctionBody(source.slice(idx), "handleAcknowledge"));
      cursor = idx + "function handleAcknowledge".length;
    }
    expect(bodies.length).toBe(2);
    const joined = bodies.join("\n");
    expect(joined.includes("createKeypair.mutateAsync")).toBe(true);
    expect(joined.includes("resetKeypair.mutateAsync")).toBe(true);
  });

  test("the RecoveryKeyModal gates its only exit on the acknowledge handler", async () => {
    const source = await Bun.file(UNLOCK_GATE).text();
    // Both <RecoveryKeyModal> usages wire onAcknowledge={handleAcknowledge} — the only way past the modal
    // is the explicit, checkbox-gated acknowledge (the modal itself is non-dismissible).
    const modalCount = (source.match(/<RecoveryKeyModal/g) ?? []).length;
    const ackWiringCount = (source.match(/onAcknowledge=\{handleAcknowledge\}/g) ?? []).length;
    expect(modalCount).toBe(2);
    expect(ackWiringCount).toBe(2);
  });
});
