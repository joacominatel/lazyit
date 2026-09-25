// SDK-v2 client harness for the W4-3 matrix (docs/05-runbooks/ai-mcp-client-matrix.md). Needs
// @modelcontextprotocol/client@2.1.0 and undici@7 installed next to it. Modes:
//   pat    — static `Authorization: Bearer $MCP_TOKEN`, list tools, call a read tool.
//   oauth  — an OAuthClientProvider (in memory); prints how far the flow gets. When
//            $CONSENT_CMD is set, it is run with the authorization URL as its argument and must
//            print the redirect URL carrying `code` (the harness's stand-in for the browser).
// RESOLVE_TO=127.0.0.1 resolves every hostname to that address (lets a non-loopback NAME such as
// lazyit.lan reach a loopback-bound instance without exposing anything).
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { Agent, fetch as ufetch } from 'undici';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [mode, url] = process.argv.slice(2);
const resolveTo = process.env.RESOLVE_TO;
const dispatcher = new Agent({
  connect: resolveTo ? { lookup: (_h, _o, cb) => cb(null, [{ address: resolveTo, family: 4 }]) } : {},
});
const fetchImpl = (u, init) => ufetch(u, { ...init, dispatcher });
const log = (...a) => console.log('[v2-client]', ...a);

function provider() {
  let tokens, verifier;
  // STATIC_CLIENT_ID pre-registers the client (no DCR/CIMD), so the flow reaches the token endpoint.
  let info = process.env.STATIC_CLIENT_ID ? { client_id: process.env.STATIC_CLIENT_ID } : undefined;
  const redirectUrl = process.env.REDIRECT_URL ?? 'http://127.0.0.1:33418/callback';
  return {
    captured: null,
    get redirectUrl() { return redirectUrl; },
    clientMetadataUrl: process.env.CIMD_URL || undefined,
    get clientMetadata() {
      return { client_name: 'w4-3 sdk-v2 harness', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    },
    clientInformation: () => info,
    saveClientInformation: (i) => { info = i; log('client registered:', i.client_id); },
    tokens: () => tokens,
    saveTokens: (t) => { tokens = t; if (process.env.TOKEN_OUT) writeFileSync(process.env.TOKEN_OUT, JSON.stringify(t), { mode: 0o600 }); log('tokens saved: access', String(t.access_token).slice(0, 9) + '…', 'scope', t.scope, 'refresh', !!t.refresh_token); },
    redirectToAuthorization(u) { this.captured = u; log('authorize URL:', u.origin + u.pathname, 'params', [...u.searchParams.keys()].join(',')); },
    saveCodeVerifier: (v) => { verifier = v; },
    codeVerifier: () => verifier,
  };
}

async function listAndCall(transport) {
  // ERA=legacy (the SDK default, 2025-11-25) | auto (probe server/discover) | 2026-07-28 (pinned).
  const era = process.env.ERA ?? 'legacy';
  const versionNegotiation = { mode: era === 'legacy' || era === 'auto' ? era : { pin: era } };
  const client = new Client({ name: 'w4-3-sdk-v2-harness', version: '1.0.0' }, { versionNegotiation });
  await client.connect(transport);
  const tools = await client.listTools();
  log('era:', era, 'server:', JSON.stringify(client.getServerVersion?.() ?? null), 'tools:', tools.tools.length);
  const r = await client.callTool({ name: process.env.TOOL ?? 'session_context', arguments: {} });
  log('callTool', process.env.TOOL ?? 'session_context', 'isError', !!r.isError, 'ok', r.structuredContent?.ok);
  await client.close();
}

try {
  if (mode === 'pat') {
    await listAndCall(new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl, requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } }));
  } else if (mode === 'oauth') {
    const p = provider();
    const t = new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl, authProvider: p });
    try {
      await listAndCall(t);
    } catch (e) {
      if (!(e instanceof UnauthorizedError) || !p.captured || !process.env.CONSENT_CMD) throw e;
      const redirected = new URL(execFileSync(process.env.CONSENT_CMD, [p.captured.href], { encoding: 'utf8' }).trim());
      log('consent returned: code', !!redirected.searchParams.get('code'), 'iss', redirected.searchParams.get('iss'));
      await t.finishAuth(redirected.searchParams); // code + iss (RFC 9207)
      await listAndCall(new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl, authProvider: p }));
    }
  }
  log('RESULT: OK');
} catch (e) {
  log('RESULT: REFUSED', e?.constructor?.name, '-', e?.message);
  process.exitCode = 2;
}
