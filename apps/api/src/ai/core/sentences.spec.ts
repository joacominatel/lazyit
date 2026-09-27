import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_SENTENCE_CODES,
  AiActionPreviewSchema,
  AiToolResultSummarySchema,
  formatAiSentences,
  isAiSentenceCode,
} from '@lazyit/shared';

// Only the toolsets' descriptors are read (see tool-coverage.spec for why these are stubbed).
jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import { ALL_TOOLSETS } from '../tools';
import { restrictedAudience } from '../tools/kb.tools';
import { toolResultEvent } from '../runtime/agent-loop';
import { errorResult, successResult } from './result-shaper';
import {
  afterPhrase,
  englishOnly,
  joinPhrases,
  messagePhrase,
  phrase,
  summaryPhrase,
} from './sentences';

/**
 * Localizable server-built sentences (#1384; tools-and-execution.md §9.1). The API sends the English AND
 * codes from the closed list `AI_SENTENCES`; the English is rendered from the code's template.
 */

describe('phrases', () => {
  it('renders the English from the template and keeps the code and params', () => {
    const p = phrase('application_create.action', { name: 'Jira' });
    expect(p).toEqual({
      text: 'Add the application "Jira" to the catalog.',
      sentences: [
        { code: 'application_create.action', params: { name: 'Jira' } },
      ],
    });
    expect(formatAiSentences(p.sentences)).toBe(p.text);
  });

  it('joins phrases with one space, skipping absent parts', () => {
    const joined = joinPhrases(
      phrase('application_update.action', { fields: 'name', name: 'Jira' }),
      false,
      null,
      phrase('application_update.actionCritical'),
    );
    expect(joined.text).toBe(
      'Change name of the application "Jira". It is a critical application: confirm with your password.',
    );
    expect(joined.sentences.map((s) => s.code)).toEqual([
      'application_update.action',
      'application_update.actionCritical',
    ]);
    expect(formatAiSentences(joined.sentences)).toBe(joined.text);
  });

  it('an English-only part makes the whole phrase English-only: no field is sent', () => {
    const joined = joinPhrases(
      phrase('kb.audience.folder', { folder: 'Team' }),
      englishOnly(';'),
    );
    expect(joined).toEqual({ text: 'Team: ;', sentences: [] });
    expect(afterPhrase(joined)).toEqual({ after: 'Team: ;' });
    expect(summaryPhrase(joined)).toEqual({ summary: 'Team: ;' });
    expect(messagePhrase(joined)).toEqual({ message: 'Team: ;' });
  });
});

describe('the results the web reads carry the sentences', () => {
  it('a success result and its tool.result event carry summarySentences', () => {
    const result = successResult('write', {
      data: null,
      ...summaryPhrase(phrase('kb_folder_create.summary')),
    });
    expect(result).toMatchObject({
      summary: 'Folder created.',
      summarySentences: [{ code: 'kb_folder_create.summary', params: {} }],
    });
    const event = toolResultEvent('call-1', result);
    expect(event.summarySentences).toEqual([
      { code: 'kb_folder_create.summary', params: {} },
    ]);
    expect(AiToolResultSummarySchema.parse(event).summarySentences).toEqual(
      event.summarySentences,
    );
  });

  it('an error result and its tool.result event carry messageSentences', () => {
    const result = errorResult('mutation', {
      code: 'STALE',
      status: 409,
      ...messagePhrase(phrase('refusal.stale')),
    });
    expect(result).toMatchObject({
      error: {
        message:
          'The target changed after this action was proposed; read it again and propose a new action',
        messageSentences: [{ code: 'refusal.stale', params: {} }],
      },
    });
    const event = toolResultEvent('call-1', result);
    expect(event.error).toEqual({
      code: 'STALE',
      message:
        'The target changed after this action was proposed; read it again and propose a new action',
      messageSentences: [{ code: 'refusal.stale', params: {} }],
    });
  });

  it('a result without sentences (an older row, a domain error) is unchanged', () => {
    const result = errorResult('mutation', {
      code: 'CONFLICT',
      message: 'A record with these values already exists',
    });
    expect(result.ok === false && 'messageSentences' in result.error).toBe(
      false,
    );
    expect('summarySentences' in toolResultEvent('c', result)).toBe(false);
  });

  it('a preview row keeps its sentences through the preview schema core stores', () => {
    const preview = AiActionPreviewSchema.parse({
      toolName: 'application_create',
      class: 'write',
      changes: [
        {
          field: 'action',
          ...afterPhrase(phrase('application_create.action', { name: 'Jira' })),
        },
      ],
      warnings: [],
      elevated: false,
      stepUpRequired: false,
    });
    expect(preview.changes[0].afterSentences).toEqual([
      { code: 'application_create.action', params: { name: 'Jira' } },
    ]);
  });
});

describe('a restricted KB audience, as sentences', () => {
  /** The English exactly as it was built before #1384 — the oracle. */
  function legacy(restricted: Record<string, unknown>[], malformed: boolean) {
    const rule = (r: Record<string, unknown>): string => {
      switch (r.kind) {
        case 'role':
          return `the ${String(r.role)} role`;
        case 'users': {
          const n = Array.isArray(r.userIds) ? r.userIds.length : 0;
          return n === 1 ? '1 named person' : `${n} named people`;
        }
        case 'appGrant':
          return `people with access to application ${String(r.applicationId)}`;
        case 'assetAssignment':
          return `people assigned asset ${String(r.assetId)}`;
        default:
          return 'an unrecognized rule (matches nobody)';
      }
    };
    return (
      'Restricted — only people matching every restricted folder on the path: ' +
      restricted
        .map(
          (f) =>
            `${String(f.name)}: ${(f.accessRules as Record<string, unknown>[])
              .map(rule)
              .join(' or ')}`,
        )
        .join('; ') +
      (malformed ? '; a folder with unreadable rules (matches nobody)' : '')
    );
  }

  const cases: [string, Record<string, unknown>[], boolean][] = [
    [
      'one folder, one rule',
      [
        {
          id: 'f1',
          name: 'Team',
          accessRules: [{ kind: 'users', userIds: ['u'] }],
        },
      ],
      false,
    ],
    [
      'two folders, several rules, every kind',
      [
        {
          id: 'f1',
          name: 'Eng',
          accessRules: [
            { kind: 'role', role: 'ADMIN' },
            { kind: 'users', userIds: ['a', 'b'] },
            { kind: 'appGrant', applicationId: 'app1' },
          ],
        },
        {
          id: 'f2',
          name: 'Eng › Secrets',
          accessRules: [
            { kind: 'assetAssignment', assetId: 'as1' },
            { kind: 'mystery' },
          ],
        },
      ],
      false,
    ],
    [
      'rules and an unreadable folder',
      [
        {
          id: 'f1',
          name: 'Ops',
          accessRules: [{ kind: 'users', userIds: [] }],
        },
      ],
      true,
    ],
    ['only an unreadable folder', [], true],
  ];

  it.each(cases)(
    '%s: the same English, and codes that render it',
    (_c, restricted, malformed) => {
      const p = restrictedAudience(restricted, malformed);
      expect(p.text).toBe(legacy(restricted, malformed));
      expect(p.sentences.length).toBeGreaterThan(0);
      expect(formatAiSentences(p.sentences)).toBe(p.text);
    },
  );

  it('a folder whose rules cannot be listed stays English-only', () => {
    const restricted = [{ id: 'f1', name: 'Odd', accessRules: [] }];
    const p = restrictedAudience(restricted, false);
    expect(p.text).toBe(legacy(restricted, false));
    expect(p.sentences).toEqual([]);
  });
});

/** The non-spec sources of the AI module that build sentences. */
function aiSources(): string {
  const root = join(__dirname, '..');
  return ['tools', 'core', 'runtime']
    .flatMap((dir) =>
      readdirSync(join(root, dir))
        .filter((f) => f.endsWith('.ts') && !f.includes('spec'))
        .map((f) => readFileSync(join(root, dir, f), 'utf8')),
    )
    .join('\n');
}

describe('coverage of the closed list', () => {
  const writes = ALL_TOOLSETS.flatMap((set) => set.tools).filter(
    (tool) => tool.class === 'write' || tool.class === 'elevated',
  );

  it.each(writes.map((tool) => [tool.name, tool] as const))(
    '%s: its result summary is built from a sentence code',
    (_name, tool) => {
      expect(tool.run.toString()).toContain('summaryPhrase');
    },
  );

  it.each(
    writes
      .filter((tool) => tool.preview?.toString().includes("field: 'action'"))
      .map((tool) => [tool.name, tool] as const),
  )('%s: its preview action row is built from a sentence code', (_n, tool) => {
    const source = tool.preview!.toString();
    const row = source.slice(source.indexOf("field: 'action'"));
    expect(row.slice(0, 200)).toContain('afterPhrase');
  });

  it('every write tool with an action row is covered (at least the known ones)', () => {
    const withAction = writes.filter((tool) =>
      tool.preview?.toString().includes("field: 'action'"),
    );
    expect(withAction.length).toBeGreaterThanOrEqual(11);
  });

  it('every code of the list is used by the API, and every code the API names is in the list', () => {
    const sources = aiSources();
    const named = new Set(
      [...sources.matchAll(/phrase\(\s*'([^']+)'/g)].map((m) => m[1]),
    );
    for (const code of named) expect(isAiSentenceCode(code)).toBe(true);
    const unused = AI_SENTENCE_CODES.filter(
      (code) => !sources.includes(`'${code}'`),
    );
    expect(unused).toEqual([]);
  });

  it('no English summary is written by hand any more: every one goes through summaryPhrase', () => {
    expect(aiSources()).not.toMatch(/\bsummary:\s*(['`"]|$)/m);
  });
});
