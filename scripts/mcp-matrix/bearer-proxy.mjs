// Loopback-only test harness for the W4-3 matrix (docs/05-runbooks/ai-mcp-client-matrix.md): forwards every
// request to TARGET, adding `Authorization: Bearer $MCP_TOKEN` (the conformance runner has no header option).
import http from 'node:http';
import https from 'node:https';
const target = new URL(process.env.TARGET ?? 'http://127.0.0.1:8080');
const token = process.env.MCP_TOKEN;
const port = Number(process.env.PORT ?? 8090);
if (!token) throw new Error('MCP_TOKEN is required');
const lib = target.protocol === 'https:' ? https : http;
http.createServer((req, res) => {
  // Host and Origin pass through untouched so transport checks (Origin, Host, DNS rebinding) stay observable.
  const headers = { ...req.headers, authorization: `Bearer ${token}` };
  if (process.env.REWRITE_HOST === '1') headers.host = target.host;
  const up = lib.request({ servername: target.hostname, protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(port, '127.0.0.1', () => console.log(`bearer proxy 127.0.0.1:${port} -> ${target.origin}`));
