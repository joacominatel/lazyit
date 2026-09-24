import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The provider boundary (ADR-0097 decision 5; provider-and-runtime.md §6.1): `apps/api/src/ai/providers/`
 * is the ONLY code in the repository that imports the AI SDK (`ai`, `ai/*`, `@ai-sdk/*`). Everything
 * else talks to a model through `ChatModelPort`, so the SDK can be upgraded or replaced (the A3 escape
 * hatch) without touching the runtime, the tools or the web.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const ALLOWED_DIR = join(REPO_ROOT, 'apps', 'api', 'src', 'ai', 'providers');
/** Whole workspaces, root files included (`apps/api/prisma.config.ts`, scripts, prisma, test…). */
const SCANNED_ROOTS = ['apps/api', 'apps/web', 'apps/agent', 'packages'];
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'generated',
  'coverage',
  '.turbo',
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

const QUOTE = String.raw`['"\`]`;
/** A module specifier of the SDK: `ai`, `ai/<subpath>`, `@ai-sdk/<package>[/<subpath>]`. */
const SPEC = String.raw`(?:ai(?:\/[\w.-]+)*|@ai-sdk\/[\w.-]+(?:\/[\w.-]+)*)`;
const COMMENTS = String.raw`(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*`;
/** Every loader that takes a module specifier as its first argument. */
const LOADER = String.raw`(?:\bimport|\brequire(?:\.resolve)?|\bmodule\.require|\bjest\.[A-Za-z_]+|\bvi\.[A-Za-z_]+|\bcreateRequire\s*\([^)]*\))`;

/**
 * The detectors, each a way to reach the SDK:
 * - `from 'ai'` (import / export … from), and a bare `import 'ai'`;
 * - a loader call — `import()`, `require()`, `require.resolve()`, `module.require()`,
 *   `jest.mock/doMock/requireActual/unstable_mockModule/…()`, `vi.*()`, `createRequire(…)()` — with
 *   comments allowed before the specifier and any quote, template literals included;
 * - any string literal naming an `@ai-sdk/*` package (no legitimate non-import use exists);
 * - a file that calls `createRequire` AND names a bare `ai` specifier anywhere (an aliased require).
 */
const SDK_IMPORT: RegExp[] = [
  new RegExp(String.raw`\bfrom\s*${QUOTE}${SPEC}${QUOTE}`),
  new RegExp(String.raw`\bimport\s+${QUOTE}${SPEC}${QUOTE}`),
  new RegExp(String.raw`${LOADER}\s*\(\s*${COMMENTS}${QUOTE}${SPEC}${QUOTE}`),
  new RegExp(String.raw`${QUOTE}@ai-sdk\/[\w.-]+(?:\/[\w.-]+)*${QUOTE}`),
];
const CREATE_REQUIRE = /\bcreateRequire\b/;
const BARE_SPEC = new RegExp(`${QUOTE}${SPEC}${QUOTE}`);

function importsSdk(source: string): boolean {
  return (
    SDK_IMPORT.some((re) => re.test(source)) ||
    (CREATE_REQUIRE.test(source) && BARE_SPEC.test(source))
  );
}

/*
 * Residual, not statically detectable: a computed specifier (`require(name)`, `import(\`${x}\`)`), `eval`,
 * or a bundler/tsconfig path alias pointing at the SDK. Those would need a runtime check of the loaded
 * module graph; they are review territory.
 */

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (SKIPPED_DIRS.has(name)) {
      return [];
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return SOURCE_FILE.test(name) ? [path] : [];
  });
}

describe('AI SDK import boundary', () => {
  it('detects every import form it guards (self-check)', () => {
    const hits = [
      `import { streamText } from 'ai';`,
      `import { MockLanguageModelV4 } from "ai/test";`,
      `import { createAnthropic } from '@ai-sdk/anthropic';`,
      `export * from 'ai';`,
      `const { streamText } = require('ai');`,
      `const m = await import('@ai-sdk/openai');`,
      'const m = await import(`ai`);',
      'const m = require(`ai/test`);',
      `const m = await import(/* webpackIgnore: true */ 'ai');`,
      `const m = await import(\n  // lazy\n  'ai');`,
      `import 'ai';`,
      `const p = require.resolve('ai');`,
      `const m = module.require('ai');`,
      `jest.mock('ai');`,
      `jest.doMock('ai', () => ({}));`,
      `jest.unstable_mockModule('@ai-sdk/google', () => ({}));`,
      `const real = jest.requireActual('ai');`,
      `const m = createRequire(__filename)('ai');`,
      `const r = createRequire(__filename);\nconst m = r('ai');`,
      `const name = '@ai-sdk/anthropic';`,
    ];
    const misses = [
      `import { x } from './ai';`,
      `import { AiModule } from '../ai/ai.module';`,
      `import { z } from 'zod';`,
      `import { y } from 'aix';`,
      `const t = useTranslations('ai');`,
      `@Controller('ai/conversations')`,
      `const domain = 'ai';`,
      '// the only importer of `ai` / `@ai-sdk/*`',
    ];
    expect(hits.filter((line) => !importsSdk(line))).toEqual([]);
    expect(misses.filter((line) => importsSdk(line))).toEqual([]);
  });

  it('finds the SDK imported inside the provider layer (the scan sees real files)', () => {
    const inside = sourceFiles(ALLOWED_DIR).filter((file) =>
      importsSdk(readFileSync(file, 'utf8')),
    );
    expect(inside.length).toBeGreaterThan(0);
  });

  it('finds no import of `ai` or `@ai-sdk/*` outside apps/api/src/ai/providers', () => {
    const offenders = SCANNED_ROOTS.flatMap((root) =>
      sourceFiles(join(REPO_ROOT, root)),
    )
      .filter((file) => !file.startsWith(ALLOWED_DIR + sep))
      .filter((file) => importsSdk(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
