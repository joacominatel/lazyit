/**
 * Compatibility regression (epic #1315 W1-B item b): the shipped api is `nest build` → `tsc` →
 * CommonJS, so at runtime `import { streamText } from 'ai'` becomes `require("ai")` and Node must load
 * the ESM-only AI SDK through `require(esm)`. Jest cannot show this (it transpiles the ESM itself,
 * ADR-0096), so this spec runs a plain Node child process — the Node that runs the suite — from the
 * api package root and requires every new dependency exactly as the compiled code will.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '../../../..');

const PROBE = `
const out = { node: process.versions.node, modules: {} };
for (const id of [
  'ai',
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/openai-compatible',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/node',
]) {
  out.modules[id] = Object.keys(require(id)).length > 0;
}
const ai_1 = require('ai');
out.streamText = typeof ai_1.streamText;
out.isStepCount = typeof ai_1.isStepCount;
out.createAnthropic = typeof require('@ai-sdk/anthropic').createAnthropic;
out.createMcpHandler = typeof require('@modelcontextprotocol/server').createMcpHandler;
process.stdout.write(JSON.stringify(out));
`;

describe('require(esm) of the AI SDK from CommonJS on the running Node', () => {
  it('loads every new runtime dependency through a plain require()', () => {
    const stdout = execFileSync(process.execPath, ['-e', PROBE], {
      cwd: API_ROOT,
      encoding: 'utf8',
    });
    const out = JSON.parse(stdout) as {
      node: string;
      modules: Record<string, boolean>;
      streamText: string;
      isStepCount: string;
      createAnthropic: string;
      createMcpHandler: string;
    };

    expect(Object.values(out.modules)).toEqual(Array(7).fill(true));
    expect(out).toMatchObject({
      streamText: 'function',
      isStepCount: 'function',
      createAnthropic: 'function',
      createMcpHandler: 'function',
    });
  });
});
