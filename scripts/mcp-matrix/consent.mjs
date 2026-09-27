#!/usr/bin/env node
// W4-3 matrix harness (docs/05-runbooks/ai-mcp-client-matrix.md). Stand-in for the browser on the consent page: given the /oauth/authorize URL a client opened,
// it calls the same API the page calls (validate, then decision=approve) with a signed-in user's
// session bearer, and prints the redirect (client redirect_uri + code + state + iss).
// Env: BASE (https://host:port), SESSION (session JWT from POST /api/auth/login), SCOPES (optional,
// space-separated; defaults to the requested scope), PASSWORD (optional; the step-up for lazyit.admin).
const authUrl = new URL(process.argv[2]);
const base = process.env.BASE;
const params = Object.fromEntries(authUrl.searchParams);
const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SESSION}` };
const v = await fetch(`${base}/api/oauth/authorize/validate`, { method: 'POST', headers: h, body: JSON.stringify(params) });
const vb = await v.json();
console.error('[consent] validate', v.status, JSON.stringify(vb).slice(0, 300));
if (!v.ok || vb.ok === false) process.exit(1);
const scopes = (process.env.SCOPES ?? params.scope ?? 'lazyit.read lazyit.write').split(' ').filter(Boolean);
const d = await fetch(`${base}/api/oauth/authorize/decision`, { method: 'POST', headers: h, body: JSON.stringify({ params, decision: 'approve', scopes, ...(process.env.PASSWORD ? { password: process.env.PASSWORD } : {}) }) });
const db = await d.json();
console.error('[consent] decision', d.status, db.redirectTo ? new URL(db.redirectTo).origin + new URL(db.redirectTo).pathname : JSON.stringify(db));
if (!db.redirectTo) process.exit(1);
console.log(db.redirectTo);
