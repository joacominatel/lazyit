import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AssetAssignment, AssetListItem } from "@lazyit/shared";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { SHARED_FORMATS } from "@/i18n/config";
import { NO_RELEASE_MARKS, type ReleaseMarks } from "@/lib/assets/assign-with-releases";
import assets from "@/messages/en/assets.json";
import common from "@/messages/en/common.json";

// bun's `mock.module` is process-wide, so the real modules go back when this file is done.
const PERMISSIONS = Bun.resolveSync("../../../../lib/hooks/use-permissions", import.meta.dir);
const USERS_HOOKS = Bun.resolveSync("../../../../lib/api/hooks/use-users", import.meta.dir);
const ASSETS_HOOKS = Bun.resolveSync("../../../../lib/api/hooks/use-assets", import.meta.dir);
const realPermissions = { ...(await import(PERMISSIONS)) };
const realUsersHooks = { ...(await import(USERS_HOOKS)) };
const realAssetsHooks = { ...(await import(ASSETS_HOOKS)) };
afterAll(() => {
  mock.module(PERMISSIONS, () => realPermissions);
  mock.module(USERS_HOOKS, () => realUsersHooks);
  mock.module(ASSETS_HOOKS, () => realAssetsHooks);
});

let granted = new Set<string>();
let held: AssetAssignment[] = [];
let heldAssets: AssetListItem[] = [];
// The user id each read was asked for — `undefined` means the read stays idle (never sent).
let assignmentsReadFor: (string | undefined)[] = [];
let assetsReadFor: (string | undefined)[] = [];

void mock.module(PERMISSIONS, () => ({
  ...realPermissions,
  useCan: (permission: string) => granted.has(permission),
}));
void mock.module(USERS_HOOKS, () => ({
  ...realUsersHooks,
  useUserAssignments: (id: string | undefined) => {
    assignmentsReadFor.push(id);
    return { data: id ? held : undefined, isLoading: false, isError: false, refetch: () => {} };
  },
}));
void mock.module(ASSETS_HOOKS, () => ({
  ...realAssetsHooks,
  useAssetsHeldBy: (id: string | undefined) => {
    assetsReadFor.push(id);
    return { data: id ? { items: heldAssets, total: heldAssets.length } : undefined };
  },
}));

const { HeldAssetsPanel, ReleaseReportList, useHeldAssets } = await import("./held-assets-panel");

const USER = "11111111-1111-4111-8111-111111111111";
const CURRENT = "ckasset00000000000000new";
const OLD = "ckasset00000000000000old";

function row(id: string, assetId: string): AssetAssignment {
  return {
    id,
    assetId,
    userId: USER,
    assignedAt: "2026-01-10T00:00:00.000Z",
    releasedAt: null,
    notes: null,
  } as AssetAssignment;
}

function Harness({ userId, marks }: { userId?: string; marks: ReleaseMarks }) {
  const state = useHeldAssets({ userId, excludeAssetId: CURRENT });
  return <HeldAssetsPanel held={state} marks={marks} dispatch={() => {}} />;
}

function render(userId: string | undefined = USER, marks: ReleaseMarks = NO_RELEASE_MARKS): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      formats={SHARED_FORMATS}
      messages={{ assets, common }}
    >
      <Harness userId={userId} marks={marks} />
    </NextIntlClientProvider>,
  );
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}

const t = assets.assign.held;

beforeEach(() => {
  granted = new Set(["user:read", "asset:write"]);
  held = [row("as-old", OLD), row("as-current", CURRENT)];
  heldAssets = [
    { id: OLD, name: "ThinkPad T14", assetTag: "LZ-0042", status: "OPERATIONAL" } as AssetListItem,
    { id: CURRENT, name: "ThinkPad T16", assetTag: "LZ-0099", status: "OPERATIONAL" } as AssetListItem,
  ];
  assignmentsReadFor = [];
  assetsReadFor = [];
});

describe("HeldAssetsPanel (#1726)", () => {
  test("lists what the picked person holds, without the asset being assigned, each releasable", () => {
    const html = render();
    expect(html).toContain(esc(t.title));
    expect(html).toContain("ThinkPad T14");
    expect(html).toContain(`href="/assets/${OLD}"`);
    expect(html).not.toContain("ThinkPad T16");
    expect(html).toContain('role="checkbox"');
    expect(html).toContain(esc("Release ThinkPad T14"));
  });

  test("without user:read the panel is hidden and neither read is sent", () => {
    granted = new Set(["asset:write"]);
    expect(render()).toBe("");
    expect(assignmentsReadFor.every((id) => id === undefined)).toBe(true);
    expect(assetsReadFor.every((id) => id === undefined)).toBe(true);
  });

  test("hidden until a person is picked", () => {
    // The dialog passes "" until a person is picked.
    expect(render("")).toBe("");
    expect(assignmentsReadFor.every((id) => !id)).toBe(true);
  });

  test("without the permission to release, the rows are read-only", () => {
    granted = new Set(["user:read"]);
    const html = render();
    expect(html).toContain("ThinkPad T14");
    expect(html).toContain(esc(t.readOnlyDescription));
    expect(html).not.toContain('role="checkbox"');
  });

  test("a person holding nothing else gets a calm empty state", () => {
    held = [row("as-current", CURRENT)];
    const html = render();
    expect(html).toContain(esc(t.empty));
    expect(html).not.toContain('role="checkbox"');
  });

  test("a marked row says it is released on Assign, and the shared note appears", () => {
    const html = render(USER, { marked: ["as-old"], note: "" });
    expect(html).toContain(esc(t.willRelease));
    expect(html).toContain("1 asset will be released");
    expect(html).toContain(esc(t.noteLabel));
  });
});

describe("ReleaseReportList", () => {
  test("names each failed release with its reason and each one that went through", () => {
    const html = renderToStaticMarkup(
      <ReleaseReportList
        released={[{ key: "a", label: "Dell U2723" }]}
        failed={[{ key: "b", label: "LZ-0042 · ThinkPad T14", message: "Assignment already released" }]}
        releasedText="released"
        failedText="not released"
      />,
    );
    expect(html).toContain("LZ-0042 · ThinkPad T14");
    expect(html).toContain("not released: Assignment already released");
    expect(html).toContain("Dell U2723");
    expect(html).toContain("released");
  });
});
