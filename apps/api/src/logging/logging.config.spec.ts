import { buildLoggerParams } from './logging.config';

// The pinoHttp options are a union (Options | stream | tuple) upstream; narrow to the shape we
// assert on. Mock request/response param types are intentionally minimal.
interface LoggerHttpOptions {
  level: string;
  transport?: { target: string; options: object };
  genReqId: (
    req: { headers: Record<string, string | string[] | undefined> },
    res: { setHeader: (name: string, value: string) => void },
  ) => string;
  customProps: (req: {
    headers: Record<string, string | string[] | undefined>;
  }) => { actor: string | null };
  customLogLevel: (
    req: object,
    res: { statusCode: number },
    err?: Error,
  ) => string;
  redact: { paths: string[] };
}

function http(nodeEnv?: string): LoggerHttpOptions {
  return buildLoggerParams(nodeEnv).pinoHttp as unknown as LoggerHttpOptions;
}

describe('buildLoggerParams', () => {
  describe('format by environment', () => {
    it('uses the pino-pretty transport and debug level outside production', () => {
      const pino = http('development');
      expect(pino.level).toBe('debug');
      expect(pino.transport?.target).toBe('pino-pretty');
      expect(pino.transport?.options).toBeDefined();
    });

    it('uses JSON (no transport) and info level in production', () => {
      const pino = http('production');
      expect(pino.level).toBe('info');
      expect(pino.transport).toBeUndefined();
    });

    it('treats an unset NODE_ENV as non-production (pretty)', () => {
      expect(http(undefined).transport).toBeDefined();
    });
  });

  describe('genReqId — request id propagation', () => {
    it('honors an inbound X-Request-Id and echoes it on the response', () => {
      const res = { setHeader: jest.fn() };
      const id = http().genReqId(
        { headers: { 'x-request-id': 'abc-123' } },
        res,
      );
      expect(id).toBe('abc-123');
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'abc-123');
    });

    it('generates a uuid when none is supplied and echoes it', () => {
      const res = { setHeader: jest.fn() };
      const id = http().genReqId({ headers: {} }, res);
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(36);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', id);
    });
  });

  describe('customLogLevel — category mapping', () => {
    const level = (statusCode: number, err?: Error) =>
      http().customLogLevel({}, { statusCode }, err);

    it('maps 5xx and thrown errors to error (CRITICAL)', () => {
      expect(level(500)).toBe('error');
      expect(level(503)).toBe('error');
      expect(level(200, new Error('boom'))).toBe('error');
    });

    it('maps 4xx to warn (WARNING)', () => {
      expect(level(400)).toBe('warn');
      expect(level(404)).toBe('warn');
    });

    it('maps 2xx/3xx to info (INFO)', () => {
      expect(level(200)).toBe('info');
      expect(level(302)).toBe('info');
    });
  });

  describe('customProps — actor', () => {
    it('surfaces the X-User-Id value as the actor', () => {
      expect(
        http().customProps({ headers: { 'x-user-id': 'user-1' } }),
      ).toEqual({
        actor: 'user-1',
      });
    });

    it('actor is null when the header is absent', () => {
      expect(http().customProps({ headers: {} })).toEqual({ actor: null });
    });
  });

  it('redacts sensitive headers', () => {
    expect(http().redact.paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-user-id"]',
      ]),
    );
  });
});
