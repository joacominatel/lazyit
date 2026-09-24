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
const SCANNED_ROOTS = [
  'apps/api/src',
  'apps/api/test',
  'apps/api/scripts',
  'apps/web',
  'apps/agent',
  'packages/shared/src',
];
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

/** `from '<m>'`, `import '<m>'`, `import('<m>')`, `require('<m>')`, `jest.mock('<m>')` of an SDK module. */
const SDK_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bjest\.(?:mock|requireActual)\s*\(\s*)['"](?:ai|ai\/[^'"]+|@ai-sdk\/[^'"]+)['"]/;

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
      `const { streamText } = require('ai');`,
      `const m = await import('@ai-sdk/openai');`,
      `import 'ai';`,
      `jest.mock('ai');`,
    ];
    const misses = [
      `import { x } from './ai';`,
      `import { AiModule } from '../ai/ai.module';`,
      `import { z } from 'zod';`,
      `import { y } from 'aix';`,
    ];
    expect(hits.filter((line) => !SDK_IMPORT.test(line))).toEqual([]);
    expect(misses.filter((line) => SDK_IMPORT.test(line))).toEqual([]);
  });

  it('finds the SDK imported inside the provider layer (the scan sees real files)', () => {
    const inside = sourceFiles(ALLOWED_DIR).filter((file) =>
      SDK_IMPORT.test(readFileSync(file, 'utf8')),
    );
    expect(inside.length).toBeGreaterThan(0);
  });

  it('finds no import of `ai` or `@ai-sdk/*` outside apps/api/src/ai/providers', () => {
    const offenders = SCANNED_ROOTS.flatMap((root) =>
      sourceFiles(join(REPO_ROOT, root)),
    )
      .filter((file) => !file.startsWith(ALLOWED_DIR + sep))
      .filter((file) => SDK_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
