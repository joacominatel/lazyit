import { afterAll, describe, expect, mock, test } from "bun:test";
import type { PasswordResetCapabilities, User } from "@lazyit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import common from "@/messages/en/common.json";
import users from "@/messages/en/users.json";

// bun's `mock.module` is process-wide, so the real hooks go back when this file is done.
const USERS_HOOKS = Bun.resolveSync("../../../../lib/api/hooks/use-users", import.meta.dir);
const PERMISSIONS = Bun.resolveSync("../../../../lib/hooks/use-permissions", import.meta.dir);
const realUsersHooks = { ...(await import(USERS_HOOKS)) };
const realPermissions = { ...(await import(PERMISSIONS)) };
afterAll(() => {
  mock.module(USERS_HOOKS, () => realUsersHooks);
  mock.module(PERMISSIONS, () => realPermissions);
});

let canManage = true;
let capabilities: PasswordResetCapabilities | undefined;
void mock.module(USERS_HOOKS, () => ({
  ...realUsersHooks,
  usePasswordResetCapabilities: () => ({ data: capabilities }),
}));
void mock.module(PERMISSIONS, () => ({
  ...realPermissions,
  useCan: () => canManage,
}));

const { UserPasswordResetButton } = await import("./user-password-reset-button");

const LOCAL: PasswordResetCapabilities = {
  canResetLocally: true,
  canEmailResetLink: true,
  canMintTemporaryPassword: true,
};

const account = {
  id: "ckuser000000000000000000",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  isActive: true,
  directoryOnly: false,
  externalId: null,
} as User;

function render(user: User = account): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ users, common }}>
        <UserPasswordResetButton user={user} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}

describe("UserPasswordResetButton (#1543)", () => {
  test("hidden outside local mode", () => {
    canManage = true;
    capabilities = { canResetLocally: false, canEmailResetLink: false, canMintTemporaryPassword: false };
    expect(render()).toBe("");
  });

  test("hidden while the capabilities load, and without user:manage", () => {
    canManage = true;
    capabilities = undefined;
    expect(render()).toBe("");
    canManage = false;
    capabilities = LOCAL;
    expect(render()).toBe("");
  });

  test("local mode offers the reset, even for an account with no IdP link", () => {
    canManage = true;
    capabilities = LOCAL;
    const html = render();
    expect(html).toContain(esc(users.passwordReset.button));
    expect(html).not.toContain('disabled=""');
  });

  test("local mode disables it for an inactive user, with the reason", () => {
    canManage = true;
    capabilities = LOCAL;
    const html = render({ ...account, isActive: false });
    expect(html).toContain('disabled=""');
    expect(html).toContain(esc(users.passwordReset.disabledInactive));
  });
});
