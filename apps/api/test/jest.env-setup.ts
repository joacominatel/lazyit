/**
 * Jest env bootstrap (runs via `setupFiles`, BEFORE the test framework + any module import).
 *
 * Wiring `WorkflowEngineModule` into `AppModule` activates `SecretService`'s fail-loud `onModuleInit`,
 * which requires a valid 32-byte `WORKFLOW_SECRET_KEY` (ADR-0054 §5). The unit suite mocks Prisma and
 * never talks to a broker, but any spec that instantiates the engine providers (or the e2e suite, which
 * boots the whole AppModule) would otherwise abort at boot. We provide a deterministic TEST key here so
 * the whole Jest suite still boots/passes; production/dev supply a real key (`openssl rand -hex 32`).
 *
 * Only sets the key when it is unset, so a CI/dev value is never clobbered. Also pins NODE_ENV=test so
 * the run sweeper's interval stays off under test (no stray timers / broker connections).
 */
import { Server } from 'node:http';
import * as net from 'node:net';

if (!process.env.WORKFLOW_SECRET_KEY) {
  // 64 hex chars → exactly 32 bytes. A throwaway test key; never a real credential.
  process.env.WORKFLOW_SECRET_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}
// Local-mode session signing key (ADR-0086 §4). The LocalCredentialService mint/verify path asserts a
// >=32-char SESSION_SIGNING_SECRET; provide a deterministic throwaway so the auth suite can sign/verify.
// Only set when unset, so a CI/dev value is never clobbered. Never a real credential.
if (!process.env.SESSION_SIGNING_SECRET) {
  process.env.SESSION_SIGNING_SECRET =
    'test-session-signing-secret-0123456789abcdef';
}

// On macOS an ephemeral `::` bind can share a port another app holds on IPv4 `*` and lose supertest's 127.0.0.1 request; BoundSocket keeps the bind synchronous, as supertest needs.
const LOOPBACK_LISTEN = Symbol.for('lazyit.test.loopbackListen');
const serverProto = Server.prototype as Server & { [LOOPBACK_LISTEN]?: true };
if (typeof net.BoundSocket === 'function' && !serverProto[LOOPBACK_LISTEN]) {
  const listen = Reflect.get(serverProto, 'listen') as (
    this: Server,
    ...a: unknown[]
  ) => Server;
  serverProto.listen = function (this: Server, ...args: unknown[]) {
    const hostless =
      args.length === 1 || (args.length === 2 && typeof args[1] === 'function');
    if (args[0] === 0 && hostless) {
      const bound = new net.BoundSocket({ host: '127.0.0.1', port: 0 });
      return listen.call(this, bound, ...args.slice(1));
    }
    return listen.apply(this, args);
  } as Server['listen'];
  serverProto[LOOPBACK_LISTEN] = true;
}
