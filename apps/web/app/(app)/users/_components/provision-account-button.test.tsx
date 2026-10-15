import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ConfigStatus, User } from "@lazyit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import users from "@/messages/en/users.json";

// bun's `mock.module` is process-wide, so the real hook goes back when this file is done.
const HOOK = Bun.resolveSync("../../../../lib/api/hooks/use-config-status", import.meta.dir);
const realHook = { ...(await import(HOOK)) };
afterAll(() => mock.module(HOOK, () => realHook));

let status: Partial<ConfigStatus> | undefined;
void mock.module(HOOK, () => ({
  ...realHook,
  useClientOnlyConfigStatus: () => ({ data: status }),
}));

const { ProvisionAccountButton } = await import("./provision-account-button");

const person = {
  id: "ckuser000000000000000000",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  directoryOnly: true,
} as User;

function render(next: Partial<ConfigStatus> | undefined): string {
  status = next;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ users }}>
        <ProvisionAccountButton user={person} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}

describe("ProvisionAccountButton (#1543)", () => {
  test("renders nothing until the auth mode is known", () => {
    expect(render(undefined)).toBe("");
  });

  test("local mode offers the temporary-password onboarding", () => {
    const html = render({ integrationMode: "local", canProvisionLocalAccounts: true });
    expect(html).toContain(esc(users.directory.provisionLocal.action));
    expect(html).not.toContain(esc(users.directory.provision.unsupported));
  });

  test("OIDC mode explains the IdP owns accounts and offers no action", () => {
    const html = render({ integrationMode: "generic-oidc", canProvisionAccounts: false });
    expect(html).toContain(esc(users.directory.provision.unsupported));
    expect(html).not.toContain("<button");
  });
});
