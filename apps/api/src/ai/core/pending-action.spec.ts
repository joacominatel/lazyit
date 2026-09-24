import { AI_PREVIEW_WARNING_CODES } from '@lazyit/shared';
import { ForbiddenException } from '@nestjs/common';
import {
  AI_CHANNEL_REFUSED_WARNINGS,
  AI_STEP_UP_WARNINGS,
  assertChannelAllows,
  channelRefusal,
  requiresStepUp,
} from './pending-action';

/**
 * The step-up rule core derives from a preview (tools-and-execution.md §9): the CEO's closed list, plus
 * the ADR-0097 decision 3 amendment (2026-09-24, #1315) — an action on a critical application requires
 * step-up, an outbound-integration change on its own does not.
 */
describe('requiresStepUp', () => {
  const elevated = (...warnings: string[]) => ({
    elevated: true,
    stepUpRequired: false,
    warnings,
  });

  it('is the closed list: the four "Opción 2" codes plus CRITICAL_APPLICATION', () => {
    expect([...AI_STEP_UP_WARNINGS].sort()).toEqual(
      [
        'CREDENTIAL_DELIVERY',
        'CRITICAL_APPLICATION',
        'IDENTITY_CHANGE',
        'PRIVILEGE_GRANT',
        'ROLE_CHANGE',
      ].sort(),
    );
    for (const code of AI_STEP_UP_WARNINGS) {
      expect(AI_PREVIEW_WARNING_CODES).toContain(code);
    }
  });

  it('does not list OUTBOUND_INTEGRATION (CEO: no password unless the application is critical)', () => {
    expect(AI_STEP_UP_WARNINGS).not.toContain('OUTBOUND_INTEGRATION');
  });

  it('a workflow write on a critical application requires step-up though the tool did not ask', () => {
    expect(
      requiresStepUp(elevated('OUTBOUND_INTEGRATION', 'CRITICAL_APPLICATION')),
    ).toBe(true);
    expect(requiresStepUp(elevated('CRITICAL_APPLICATION'))).toBe(true);
  });

  it('an access revoke on a critical application requires step-up', () => {
    expect(
      requiresStepUp(
        elevated('EXTERNAL_DEPROVISIONING', 'CRITICAL_APPLICATION'),
      ),
    ).toBe(true);
  });

  it('an outbound integration on a non-critical application needs no step-up', () => {
    expect(requiresStepUp(elevated('OUTBOUND_INTEGRATION'))).toBe(false);
    expect(
      requiresStepUp(elevated('OUTBOUND_INTEGRATION', 'EXTERNAL_PROVISIONING')),
    ).toBe(false);
  });

  it('a tool may still ask for step-up on its own', () => {
    expect(
      requiresStepUp({
        ...elevated('OUTBOUND_INTEGRATION'),
        stepUpRequired: true,
      }),
    ).toBe(true);
  });

  it('derives step-up from a WRITE-class preview too: an access revoke on a critical app (not escalated)', () => {
    expect(
      // A `write`-class preview that was not escalated to `elevated`.
      requiresStepUp({
        stepUpRequired: false,
        warnings: ['EXTERNAL_DEPROVISIONING', 'CRITICAL_APPLICATION'],
      }),
    ).toBe(true);
  });

  it('a write-class preview without a listed warning needs no step-up', () => {
    expect(
      // A `write`-class preview that was not escalated to `elevated`.
      requiresStepUp({
        stepUpRequired: false,
        warnings: ['EXTERNAL_DEPROVISIONING', 'OUTBOUND_INTEGRATION'],
      }),
    ).toBe(false);
  });
});

/**
 * The per-channel refusal seam (a CEO question on headless actions over critical applications is open,
 * #1315): empty today, so nothing is refused; one entry turns a refusal on.
 */
describe('channel refusal by warning', () => {
  it('refuses nothing today, on any channel', () => {
    for (const channel of ['CHAT', 'MCP', 'HEADLESS'] as const) {
      expect(AI_CHANNEL_REFUSED_WARNINGS[channel]).toEqual([]);
      expect(
        channelRefusal(channel, [
          'CRITICAL_APPLICATION',
          'OUTBOUND_INTEGRATION',
        ]),
      ).toBeUndefined();
      expect(() =>
        assertChannelAllows(channel, ['CRITICAL_APPLICATION']),
      ).not.toThrow();
    }
  });

  it('refuses cleanly, as a 403, once a channel lists the warning', () => {
    const refused = {
      CHAT: [],
      MCP: [],
      HEADLESS: ['CRITICAL_APPLICATION'],
    } as const;
    expect(
      channelRefusal(
        'HEADLESS',
        ['OUTBOUND_INTEGRATION', 'CRITICAL_APPLICATION'],
        refused,
      ),
    ).toBe('CRITICAL_APPLICATION');
    expect(
      channelRefusal('CHAT', ['CRITICAL_APPLICATION'], refused),
    ).toBeUndefined();
    expect(() =>
      assertChannelAllows('HEADLESS', ['CRITICAL_APPLICATION'], refused),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertChannelAllows('HEADLESS', ['OUTBOUND_INTEGRATION'], refused),
    ).not.toThrow();
  });
});
