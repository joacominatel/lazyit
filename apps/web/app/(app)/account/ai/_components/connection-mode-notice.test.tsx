import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import oauth from "@/messages/en/oauth.json";
import { ConnectionModeNotice } from "./connection-mode-notice";

// Compared on strings without an apostrophe, which the markup escapes. `/ai/status` reports MCP unavailable both when the server is off and when the caller lacks ai:connect (AUD-083).
function render(canConnect: boolean): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ oauth }}>
      <ConnectionModeNotice mode={{ kind: "unavailable", auth: "oauth" }} canConnect={canConnect} />
    </NextIntlClientProvider>,
  );
}

describe("ConnectionModeNotice — unavailable", () => {
  test("without ai:connect it names the missing permission, not a switched-off server", () => {
    const html = render(false);
    expect(html).toContain(oauth.mode.unavailableRole.body);
    expect(html).not.toContain(oauth.mode.unavailable.title);
  });

  test("with ai:connect it says the MCP server is off", () => {
    const html = render(true);
    expect(html).toContain(oauth.mode.unavailable.title);
    expect(html).not.toContain(oauth.mode.unavailableRole.body);
  });
});
