import { assertUrlAllowed } from './egress-guard';
import { EgressError, type DnsLookup } from './types';

/**
 * SEC-076 — `refuseUserinfo`. Node's http client turns a URL's `user:pass@` into
 * `Authorization: Basic …`; the workflow engine asks the guard to refuse such a URL (a legacy
 * connection row saved before write validation) with a clear reason and without echoing the URL.
 */

const PUBLIC_V4 = '93.184.216.34';
const publicLookup: DnsLookup = () =>
  Promise.resolve([{ address: PUBLIC_V4, family: 4 as const }]);

describe('assertUrlAllowed — refuseUserinfo (SEC-076)', () => {
  it.each(['https://svc:hunter2@example.com/', 'https://svc@example.com/'])(
    'refuses %j with userinfo-not-allowed and no url in the error',
    async (url) => {
      const err: unknown = await assertUrlAllowed(url, {
        lookup: publicLookup,
        refuseUserinfo: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EgressError);
      expect(err).toMatchObject({ reason: 'userinfo-not-allowed' });
      expect((err as EgressError).url).toBeUndefined();
      expect((err as EgressError).message).not.toContain('hunter2');
    },
  );

  it('admits a URL without userinfo (an @ in the path is not userinfo)', async () => {
    await expect(
      assertUrlAllowed('https://example.com/a@b', {
        lookup: publicLookup,
        refuseUserinfo: true,
      }),
    ).resolves.toMatchObject({ address: PUBLIC_V4 });
  });

  it('leaves callers that do not opt in unchanged', async () => {
    await expect(
      assertUrlAllowed('https://svc@example.com/', { lookup: publicLookup }),
    ).resolves.toMatchObject({ address: PUBLIC_V4 });
  });
});
