import type { ModuleRef } from '@nestjs/core';
import { AiConnectionTestResultSchema } from '@lazyit/shared';
import { EgressError } from '../../common/egress/types';
import type { ResolvedAiProviderConfig } from '../core/ports/ai-settings.port';
import {
  CHAT_MODEL_PORT,
  type ChatModelPort,
  type ChatModelStepRequest,
  type ChatModelStepResult,
} from '../core/ports/chat-model.port';
import {
  AI_CONNECTION_TEST_CODES,
  AiConnectionTester,
  classifyProviderFailure,
} from './ai-connection-tester';
import { currentProviderOverride } from './ai-provider-override';

const CONFIG: ResolvedAiProviderConfig = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  baseUrl: null,
  apiKey: 'sk-ant-SECRET-inline',
  allowPrivateNetwork: false,
  effort: null,
  providerOptions: null,
};

const USAGE = { inputTokens: 10, outputTokens: 2 };

/** A port whose step runs `impl` asynchronously (a sync throw becomes a rejection). */
function makePort(
  impl: (req: ChatModelStepRequest) => ChatModelStepResult,
): ChatModelPort {
  return {
    step: jest.fn((req: ChatModelStepRequest) =>
      Promise.resolve().then(() => impl(req)),
    ),
    toolResultsMessage: jest.fn(),
    userMessage: jest.fn((text: string) => ({ role: 'user', content: text })),
  };
}

function testerWith(port: ChatModelPort | null) {
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token !== CHAT_MODEL_PORT || !port) throw new Error('not found');
      return port;
    }),
  } as unknown as ModuleRef;
  return new AiConnectionTester(moduleRef);
}

describe('AiConnectionTester', () => {
  it('passes when the model calls the ping tool, running under the draft config', async () => {
    let seenOverride: ResolvedAiProviderConfig | undefined;
    let request: ChatModelStepRequest | undefined;
    const port = makePort((req) => {
      seenOverride = currentProviderOverride();
      request = req;
      return {
        responseMessages: [],
        toolCalls: [{ toolCallId: 't1', toolName: 'ping', input: {} }],
        finishReason: 'tool-calls',
        usage: USAGE,
      };
    });
    const result = await testerWith(port).test(CONFIG);
    expect(result).toMatchObject({
      ok: true,
      checks: { auth: true, model: true, toolCalling: true },
      error: null,
    });
    expect(AiConnectionTestResultSchema.parse(result)).toEqual(result);
    // The provider layer resolves the draft through the settings reader while the step runs.
    expect(seenOverride).toEqual(CONFIG);
    expect(currentProviderOverride()).toBeUndefined();
    expect(request).toMatchObject({
      model: { provider: 'anthropic', modelId: 'claude-opus-5' },
      toolChoice: 'auto',
      tools: [expect.objectContaining({ name: 'ping' })],
    });
    // The key never travels in the request itself.
    expect(JSON.stringify(request)).not.toContain(CONFIG.apiKey);
  });

  it('fails the tool-calling check when the model answers without a tool call', async () => {
    const port = makePort(() => ({
      responseMessages: [],
      toolCalls: [],
      finishReason: 'stop',
      usage: USAGE,
    }));
    const result = await testerWith(port).test(CONFIG);
    expect(result).toMatchObject({
      ok: false,
      checks: { auth: true, model: true, toolCalling: false },
      error: { code: AI_CONNECTION_TEST_CODES.toolCallingUnsupported },
    });
  });

  it('maps an auth failure and never echoes the upstream message', async () => {
    const port = makePort(() => {
      throw Object.assign(
        new Error(
          '401 invalid x-api-key sk-ant-SECRET-inline {"upstream":"body"}',
        ),
        { errorClass: 'auth' },
      );
    });
    const result = await testerWith(port).test(CONFIG);
    expect(result).toMatchObject({
      ok: false,
      checks: { auth: false, model: null, toolCalling: null },
      error: { code: 'PROVIDER_AUTH' },
    });
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('upstream');
  });

  it('maps a bad request to a failed model check', async () => {
    const port = makePort(() => {
      throw Object.assign(new Error('model not found'), {
        code: 'PROVIDER_BAD_REQUEST',
      });
    });
    const result = await testerWith(port).test(CONFIG);
    expect(result.checks).toEqual({
      auth: true,
      model: false,
      toolCalling: null,
    });
  });

  it('answers a clean failure when the provider layer is not bound', async () => {
    const result = await testerWith(null).test(CONFIG);
    expect(result).toMatchObject({
      ok: false,
      error: { code: AI_CONNECTION_TEST_CODES.providerLayerUnavailable },
    });
  });

  describe('classifyProviderFailure', () => {
    it.each([
      [new EgressError('blocked-address', 'no'), 'EGRESS_DENIED'],
      [new EgressError('scheme-not-allowed', 'no'), 'EGRESS_DENIED'],
      [new EgressError('deadline-exceeded', 'slow'), 'PROVIDER_UNAVAILABLE'],
      [{ code: 'PROVIDER_RATE_LIMIT' }, 'PROVIDER_RATE_LIMIT'],
      [{ errorClass: 'egress_denied' }, 'EGRESS_DENIED'],
      [{ class: 'unavailable' }, 'PROVIDER_UNAVAILABLE'],
      [{ name: 'AbortError' }, 'CANCELLED'],
      [{ code: 'ECONNRESET' }, 'PROVIDER_UNAVAILABLE'],
      [new Error('anything'), 'PROVIDER_UNAVAILABLE'],
      ['a string', 'PROVIDER_UNAVAILABLE'],
    ])('%p → %s', (err, code) => {
      expect(classifyProviderFailure(err)).toBe(code);
    });
  });
});
