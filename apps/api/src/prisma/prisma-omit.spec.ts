import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { includeOmitted, PRISMA_GLOBAL_OMIT } from './prisma-omit';

/**
 * The CI guard of the client-level omit (ADR-0105, #1518). It parses `prisma/schema.prisma` and fails
 * when a SCALAR column whose name looks secret is neither in {@link PRISMA_GLOBAL_OMIT} nor on the
 * commented allowlist below — so a new credential, digest, ciphertext or key column cannot ship
 * serialized by default. It also fails on a stale omit entry (a renamed or dropped column), which the
 * client would otherwise ignore silently.
 *
 * Adding a column that matches: omit it in `prisma-omit.ts` (and opt it back in only where it is
 * genuinely needed), or add it here with the reason it is not secret.
 */
const SECRET_LIKE =
  /hash|token|cipher|iv$|authTag|secret|privateKey|wrappedDek|accessRules/i;

/** `Model.column` → why it matches the pattern but is NOT secret and stays serialized. */
const ALLOWLIST: Record<string, string> = {
  // The short, non-secret prefix shown in the UI to recognise a token (ADR-0048); the secret is never stored.
  'ServiceAccount.tokenPrefix': 'display prefix, not the token',
  // The OIDC sign-out cutoff (#1715): a timestamp the auth guard compares, not a credential.
  'User.oidcTokensNotBefore': 'revocation timestamp, not a token',
  // A foreign key to WorkflowSecret: an id, not secret material.
  'WorkflowConnection.secretId': 'foreign key to the (omitted) secret row',
  // SHA-256 of an uploaded import file, used to spot a re-upload; a content digest, not a credential.
  'ImportSession.fileHash': 'content digest of the uploaded file',
  'ImportRun.fileHash': 'content digest of the uploaded file',
  // LLM token budgets and usage counters (ADR-0097): numbers, not credentials.
  'AiSettings.maxOutputTokens': 'LLM token budget',
  'AiSettings.contextTokenLimit': 'LLM token budget',
  'AiSettings.dailyTokenLimitPerPrincipal': 'LLM token budget',
  'AiRun.inputTokens': 'LLM usage counter',
  'AiRun.outputTokens': 'LLM usage counter',
  'AiRun.cachedInputTokens': 'LLM usage counter',
  'AiUsage.inputTokens': 'LLM usage counter',
  'AiUsage.outputTokens': 'LLM usage counter',
  'AiUsage.cachedInputTokens': 'LLM usage counter',
  'AiUsage.reasoningTokens': 'LLM usage counter',
  // Integrity digests of the toolset / a tool call's input and schema (ADR-0097): not credentials.
  'AiConversation.toolsetHash': 'integrity digest of the toolset',
  'AiToolInvocation.inputHash': 'integrity digest of the tool input',
  'AiToolInvocation.schemaHash': 'integrity digest of the tool schema',
};

interface ScalarColumn {
  model: string;
  column: string;
}

/** Every scalar column of every model (relation fields and block attributes excluded). */
function scalarColumns(schema: string): ScalarColumn[] {
  const models = new Set(
    [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]),
  );
  const columns: ScalarColumn[] = [];
  let current: string | null = null;
  for (const raw of schema.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = open[1];
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    const field = /^(\w+)\s+(\w+)(\[\])?\??/.exec(line);
    if (!field || line.startsWith('@@')) continue;
    const [, column, type] = field;
    if (models.has(type)) continue; // a relation, not a column
    columns.push({ model: current, column });
  }
  return columns;
}

const lowerFirst = (name: string): string =>
  name.charAt(0).toLowerCase() + name.slice(1);

const omitted = PRISMA_GLOBAL_OMIT as Record<
  string,
  Record<string, boolean> | undefined
>;

describe('PRISMA_GLOBAL_OMIT covers every secret-looking column (ADR-0105)', () => {
  const schema = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  const columns = scalarColumns(schema);

  it('parses the schema (sanity: known columns are found, relations are not)', () => {
    const names = new Set(columns.map((c) => `${c.model}.${c.column}`));
    expect(names.has('User.passwordHash')).toBe(true);
    expect(names.has('SecretItem.iv')).toBe(true);
    expect(names.has('WorkflowConnection.secret')).toBe(false); // relation
    expect(columns.length).toBeGreaterThan(500);
  });

  it('every matching column is omitted or allowlisted with a reason', () => {
    const uncovered = columns
      .filter(({ column }) => SECRET_LIKE.test(column))
      .filter(
        ({ model, column }) =>
          omitted[lowerFirst(model)]?.[column] !== true &&
          !(`${model}.${column}` in ALLOWLIST),
      )
      .map(({ model, column }) => `${model}.${column}`);
    expect(uncovered).toEqual([]);
  });

  it('no column is both omitted and allowlisted', () => {
    const both = Object.keys(ALLOWLIST).filter((key) => {
      const [model, column] = key.split('.');
      return omitted[lowerFirst(model)]?.[column] === true;
    });
    expect(both).toEqual([]);
  });

  it('every omit entry and allowlist entry names a real scalar column', () => {
    const real = new Set(
      columns.map((c) => `${lowerFirst(c.model)}.${c.column}`),
    );
    const staleOmit = Object.entries(omitted).flatMap(([model, cols]) =>
      Object.keys(cols ?? {})
        .map((col) => `${model}.${col}`)
        .filter((key) => !real.has(key)),
    );
    const staleAllow = Object.keys(ALLOWLIST).filter((key) => {
      const [model, column] = key.split('.');
      return !real.has(`${lowerFirst(model)}.${column}`);
    });
    expect([...staleOmit, ...staleAllow]).toEqual([]);
  });

  it('includeOmitted re-includes exactly the omitted columns of a model', () => {
    expect(includeOmitted('smtpSettings')).toEqual({
      passwordCiphertext: false,
      passwordIv: false,
      passwordAuthTag: false,
    });
    expect(includeOmitted('user')).toEqual({ passwordHash: false });
  });
});
