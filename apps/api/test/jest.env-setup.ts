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
if (!process.env.WORKFLOW_SECRET_KEY) {
  // 64 hex chars → exactly 32 bytes. A throwaway test key; never a real credential.
  process.env.WORKFLOW_SECRET_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}
