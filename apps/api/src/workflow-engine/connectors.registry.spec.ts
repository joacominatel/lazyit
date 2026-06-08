import { ConnectorRegistry } from './connectors.registry';
import { ManualStepHandler } from './handlers/manual.handler';
import { RestStepHandler } from './handlers/rest.handler';
import { WebhookOutStepHandler } from './handlers/webhook-out.handler';

describe('ConnectorRegistry', () => {
  const registry = new ConnectorRegistry(
    new RestStepHandler(),
    new WebhookOutStepHandler(),
    new ManualStepHandler(),
  );

  it('resolves the three v1 connector kinds to their handlers', () => {
    expect(registry.get('REST')?.kind).toBe('REST');
    expect(registry.get('WEBHOOK_OUT')?.kind).toBe('WEBHOOK_OUT');
    expect(registry.get('MANUAL')?.kind).toBe('MANUAL');
    expect(registry.has('REST')).toBe(true);
    expect(registry.kinds.sort()).toEqual(['MANUAL', 'REST', 'WEBHOOK_OUT']);
  });

  it('returns undefined for the RESERVED kinds (SDK / MCP / PREBUILT / CUSTOM)', () => {
    for (const reserved of ['SDK', 'MCP', 'PREBUILT', 'CUSTOM'] as const) {
      expect(registry.get(reserved)).toBeUndefined();
      expect(registry.has(reserved)).toBe(false);
    }
  });

  it('require() throws a clear "not implemented in v1" error for a reserved kind', () => {
    expect(() => registry.require('MCP')).toThrow(
      /reserved slot not implemented in v1/,
    );
    expect(registry.require('REST').kind).toBe('REST');
  });
});
