import type { OpenAPIObject } from '@nestjs/swagger';
import { addStandardErrorResponses } from './openapi-errors';

// Fix 7 (contract polish): document the standard error contract once, globally (ADR-0018).
describe('addStandardErrorResponses', () => {
  function baseDoc(): OpenAPIObject {
    return {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/assets': {
          get: { responses: { '200': { description: 'OK' } } },
          post: {
            responses: {
              '201': { description: 'Created' },
              // Pre-declared conflict — must NOT be overwritten.
              '409': { description: 'Custom conflict' },
            },
          },
        },
      },
    } as unknown as OpenAPIObject;
  }

  it('registers the shared ApiError component schema', () => {
    const doc = addStandardErrorResponses(baseDoc());
    expect(doc.components?.schemas?.ApiError).toBeDefined();
  });

  it('adds the standard error statuses to every operation, referencing ApiError', () => {
    const doc = addStandardErrorResponses(baseDoc());
    const get = doc.paths['/assets'].get!.responses as Record<
      string,
      { content?: { 'application/json': { schema: { $ref: string } } } }
    >;
    for (const status of ['400', '401', '403', '404', '409', '500']) {
      expect(get[status]).toBeDefined();
    }
    expect(get['404'].content?.['application/json'].schema.$ref).toBe(
      '#/components/schemas/ApiError',
    );
  });

  it('preserves the success response and never overwrites a pre-declared error response', () => {
    const doc = addStandardErrorResponses(baseDoc());
    const post = doc.paths['/assets'].post!.responses as Record<
      string,
      { description?: string }
    >;
    expect(post['201'].description).toBe('Created');
    // The handler's explicit 409 wins over the standard one.
    expect(post['409'].description).toBe('Custom conflict');
  });
});
