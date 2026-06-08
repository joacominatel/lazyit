import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * SEC-A5 regression guard. The manual-task `prompt` and any run/step text carry UNTRUSTED context (the
 * grantee display name, free-form human-entered values). React escapes text children by default, so the
 * single way to reintroduce a stored-XSS sink is `dangerouslySetInnerHTML`. This test scans every
 * workflow-engine surface (the per-app Workflows subtree, the Settings/Integrations subtree, the
 * `lib/workflow` helpers and any `workflow-*` shared components) and fails if that sink ever appears —
 * untrusted workflow context must be rendered as escaped text ONLY.
 */
const WEB_ROOT = resolve(import.meta.dir, "../..");

function isWorkflowSurface(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.includes("/node_modules/")) return false;
  if (normalized.endsWith(".test.ts") || normalized.endsWith(".test.tsx")) {
    return false;
  }
  return (
    normalized.includes("/workflows/") ||
    normalized.includes("/lib/workflow/") ||
    normalized.includes("/settings/integrations/") ||
    /\/workflow-[^/]+\.(ts|tsx)$/.test(normalized)
  );
}

function collectWorkflowFiles(): string[] {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const rel of glob.scanSync({ cwd: WEB_ROOT, onlyFiles: true })) {
    const abs = resolve(WEB_ROOT, rel);
    if (isWorkflowSurface(abs)) files.push(abs);
  }
  return files;
}

describe("workflow surfaces never use dangerouslySetInnerHTML (SEC-A5)", () => {
  const files = collectWorkflowFiles();

  test("at least the workflow data-layer files are discovered", () => {
    // Guards the scanner itself: if the glob silently matched nothing, the assertion below is vacuous.
    expect(files.length).toBeGreaterThan(0);
  });

  test("the new C3/C4 (test-connection + dry-run) surfaces are in scope", () => {
    // The C3/C4 affordances render resolved grantee PII, would-be request bodies and ‹secret:label›
    // placeholders — pin them into the scan so a future refactor can't quietly drop them from the guard.
    const rel = files.map((file) =>
      file.slice(WEB_ROOT.length + 1).replaceAll("\\", "/"),
    );
    const required = [
      "app/(app)/applications/[id]/workflows/_components/connection-test.tsx",
      "app/(app)/applications/[id]/workflows/_components/builder/dry-run-dialog.tsx",
      "app/(app)/applications/[id]/workflows/_components/builder/dry-run-timeline.tsx",
    ];
    for (const path of required) {
      expect(rel).toContain(path);
    }
  });

  for (const file of files) {
    test(`${file.slice(WEB_ROOT.length + 1)} has no dangerouslySetInnerHTML`, async () => {
      const source = await Bun.file(file).text();
      expect(source.includes("dangerouslySetInnerHTML")).toBe(false);
    });
  }
});
