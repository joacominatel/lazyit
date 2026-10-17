import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import setup from "@/messages/en/setup.json";
import { StepWelcome } from "./step-welcome";
import type { IdpChoice } from "./types";

function render(choice: IdpChoice): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ setup }}>
      <StepWelcome choice={choice} onNext={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe("StepWelcome", () => {
  test("OIDC mode shows one explanatory card, no picker, and the snippet for web and API", () => {
    const html = render("byoi");
    expect(html).toContain(setup.welcome.byoi.title);
    expect(html).not.toContain('role="radiogroup"');
    for (const key of [
      "AUTH_ISSUER=",
      "AUTH_CLIENT_ID=",
      "AUTH_CLIENT_SECRET=",
      "AUTH_MODE=oidc",
      "OIDC_ISSUER=",
      "OIDC_CLIENT_ID=",
      "OIDC_JWKS_URI=",
    ]) {
      expect(html).toContain(key);
    }
    expect(html).not.toContain("IDENTITY_PROVIDER_TYPE");
    expect(html.toLowerCase()).not.toContain("zitadel");
  });

  test("local mode explains built-in accounts and shows no snippet", () => {
    const html = render("local");
    expect(html).toContain(setup.welcome.local.title);
    expect(html).not.toContain("AUTH_ISSUER");
  });
});
