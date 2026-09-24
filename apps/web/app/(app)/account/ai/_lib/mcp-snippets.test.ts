import { describe, expect, test } from "bun:test";
import {
  buildMcpClientSnippets,
  claudePluginCommands,
  detectMcpConnectMode,
  marketplaceName,
  marketplaceUrl,
  mcpEndpointUrl,
  TOKEN_PLACEHOLDER,
} from "./mcp-snippets";

describe("endpoints", () => {
  test("the MCP endpoint and marketplace hang off the bare origin", () => {
    expect(mcpEndpointUrl("https://it.acme.io/")).toBe("https://it.acme.io/mcp");
    expect(mcpEndpointUrl("https://it.acme.io/account/ai?x=1")).toBe(
      "https://it.acme.io/mcp",
    );
    expect(marketplaceUrl("https://it.acme.io")).toBe(
      "https://it.acme.io/api/ai/claude-code/marketplace.json",
    );
  });

  test("the marketplace name mirrors the API: lazyit-<host>, kebab-case, port included", () => {
    expect(marketplaceName("https://it.acme.io")).toBe("lazyit-it-acme-io");
    expect(marketplaceName("https://LAZYIT.Example.com:8443")).toBe(
      "lazyit-lazyit-example-com-8443",
    );
    // The default port is not part of the host.
    expect(marketplaceName("https://it.acme.io:443")).toBe("lazyit-it-acme-io");
  });

  test("the plugin commands name the marketplace the instance serves", () => {
    expect(claudePluginCommands("https://it.acme.io")).toEqual({
      marketplaceAdd:
        "claude plugin marketplace add https://it.acme.io/api/ai/claude-code/marketplace.json",
      pluginInstall: "claude plugin install lazyit@lazyit-it-acme-io",
    });
  });
});

describe("buildMcpClientSnippets", () => {
  test("oauth: URL only, no header, no token anywhere", () => {
    const s = buildMcpClientSnippets("https://it.acme.io", "oauth");
    expect(s.endpoint).toBe("https://it.acme.io/mcp");
    expect(s.claudeCode).toBe(
      "claude mcp add --transport http lazyit https://it.acme.io/mcp",
    );
    expect(JSON.parse(s.cursor)).toEqual({
      mcpServers: { lazyit: { url: "https://it.acme.io/mcp" } },
    });
    expect(JSON.parse(s.vscode)).toEqual({
      servers: { lazyit: { type: "http", url: "https://it.acme.io/mcp" } },
    });
    expect(s.authorizationHeader).toBeNull();
    for (const text of [s.claudeCode, s.cursor, s.vscode]) {
      expect(text).not.toContain("Bearer");
      expect(text).not.toContain(TOKEN_PLACEHOLDER);
    }
  });

  test("personal-token: a Bearer header with the placeholder, never a real token", () => {
    const s = buildMcpClientSnippets("http://192.168.1.20:8080", "personal-token");
    expect(s.endpoint).toBe("http://192.168.1.20:8080/mcp");
    expect(s.claudeCode).toContain(
      "claude mcp add --transport http lazyit http://192.168.1.20:8080/mcp",
    );
    expect(s.claudeCode).toContain(
      `--header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
    );
    expect(JSON.parse(s.cursor)).toEqual({
      mcpServers: {
        lazyit: {
          url: "http://192.168.1.20:8080/mcp",
          headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
        },
      },
    });
    const vscode = JSON.parse(s.vscode);
    expect(vscode.inputs[0]).toMatchObject({
      type: "promptString",
      id: "lazyit-token",
      password: true,
    });
    expect(vscode.servers.lazyit).toEqual({
      type: "http",
      url: "http://192.168.1.20:8080/mcp",
      headers: { Authorization: "Bearer ${input:lazyit-token}" },
    });
    expect(s.authorizationHeader).toBe(
      `Authorization: Bearer ${TOKEN_PLACEHOLDER}`,
    );
    for (const text of [s.claudeCode, s.cursor, s.vscode]) {
      expect(text).not.toMatch(/lzit_pat_/);
    }
  });
});

describe("detectMcpConnectMode", () => {
  const ok = (mcp: unknown) => ({ status: "success" as const, data: { mcp } });

  test("fails closed while loading, on error and on an unrecognized body", () => {
    expect(detectMcpConnectMode({ status: "pending" }, "https:")).toEqual({
      kind: "unknown",
    });
    expect(detectMcpConnectMode({ status: "error" }, "https:")).toEqual({
      kind: "unknown",
    });
    expect(
      detectMcpConnectMode({ status: "success", data: null }, "https:"),
    ).toEqual({ kind: "unknown" });
    expect(
      detectMcpConnectMode({ status: "success", data: { chat: {} } }, "https:"),
    ).toEqual({ kind: "unknown" });
  });

  test("MCP off or no ai:connect → unavailable, keeping the known auth mode", () => {
    expect(
      detectMcpConnectMode(ok({ available: false, auth: "oauth" }), "https:"),
    ).toEqual({ kind: "unavailable", auth: "oauth" });
    expect(
      detectMcpConnectMode(
        ok({ available: false, auth: "personal-token" }),
        "http:",
      ),
    ).toEqual({ kind: "unavailable", auth: "personal-token" });
  });

  test("an unknown auth mode never offers an install", () => {
    expect(
      detectMcpConnectMode(ok({ available: true, auth: "magic" }), "https:"),
    ).toEqual({ kind: "unavailable", auth: null });
    expect(
      detectMcpConnectMode(ok({ available: "yes", auth: "oauth" }), "https:"),
    ).toEqual({ kind: "unavailable", auth: "oauth" });
  });

  test("oauth over https has nothing to add; over http it warns", () => {
    expect(
      detectMcpConnectMode(ok({ available: true, auth: "oauth" }), "https:"),
    ).toEqual({ kind: "oauth", notes: [] });
    expect(
      detectMcpConnectMode(ok({ available: true, auth: "oauth" }), "http:"),
    ).toEqual({ kind: "oauth", notes: ["viewing-over-http"] });
  });

  test("personal tokens explain why: plain HTTP, or an HTTPS page on an instance not configured for it", () => {
    expect(
      detectMcpConnectMode(
        ok({ available: true, auth: "personal-token" }),
        "http:",
      ),
    ).toEqual({ kind: "personal-token", notes: ["plain-http"] });
    expect(
      detectMcpConnectMode(
        ok({ available: true, auth: "personal-token" }),
        "https:",
      ),
    ).toEqual({ kind: "personal-token", notes: ["https-not-configured"] });
  });
});
