import {
  projectApplication,
  projectArticle,
  projectAsset,
  projectLocation,
  projectUser,
  type AssetRow,
} from './search.documents';

// Pure projectors: assert each maps a row to exactly the documented search fields (id + searchable
// columns), passes nulls through, and drops everything else (relations, blobs, timestamps).

describe('search document projectors', () => {
  it('projectAsset keeps id/name/serial/assetTag/status/notes and nothing else', () => {
    // A wider row (extra columns the full Prisma asset would carry) assigned to AssetRow, to prove
    // the projector copies only the searchable subset and drops everything else.
    const row: AssetRow & Record<string, unknown> = {
      id: 'a1',
      name: 'SRV-01',
      serial: 'SN1',
      assetTag: 'TAG1',
      status: 'OPERATIONAL',
      notes: 'rack 3',
      specs: { ram: '64GB' },
      modelId: 'm1',
      deletedAt: null,
    };
    expect(projectAsset(row)).toEqual({
      id: 'a1',
      name: 'SRV-01',
      serial: 'SN1',
      assetTag: 'TAG1',
      status: 'OPERATIONAL',
      notes: 'rack 3',
    });
  });

  it('projectAsset passes nullable fields through as null', () => {
    expect(
      projectAsset({
        id: 'a1',
        name: 'SRV-01',
        serial: null,
        assetTag: null,
        status: 'IN_STORAGE',
        notes: null,
      }),
    ).toEqual({
      id: 'a1',
      name: 'SRV-01',
      serial: null,
      assetTag: null,
      status: 'IN_STORAGE',
      notes: null,
    });
  });

  it('projectArticle keeps id/slug/title/excerpt/status/content (content searchable — ADR-0042)', () => {
    expect(
      projectArticle({
        id: 'art1',
        slug: 'vpn-guide',
        title: 'VPN Guide',
        excerpt: 'how to vpn',
        status: 'PUBLISHED',
        content: '## Step 1\nOpen the VPN client and connect to the gateway.',
      }),
    ).toEqual({
      id: 'art1',
      slug: 'vpn-guide',
      title: 'VPN Guide',
      excerpt: 'how to vpn',
      status: 'PUBLISHED',
      content: '## Step 1\nOpen the VPN client and connect to the gateway.',
    });
  });

  it('projectUser keeps id/firstName/lastName/email', () => {
    expect(
      projectUser({
        id: 'u1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@b.com',
      }),
    ).toEqual({
      id: 'u1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@b.com',
    });
  });

  it('projectLocation keeps id/name/type/address/floor', () => {
    expect(
      projectLocation({
        id: 'l1',
        name: 'HQ',
        type: 'OFFICE',
        address: '123 Main St',
        floor: 'PB',
      }),
    ).toEqual({
      id: 'l1',
      name: 'HQ',
      type: 'OFFICE',
      address: '123 Main St',
      floor: 'PB',
    });
  });

  it('projectApplication keeps id/name/vendor/description', () => {
    expect(
      projectApplication({
        id: 'app1',
        name: 'Jira',
        vendor: 'Atlassian',
        description: 'tracker',
      }),
    ).toEqual({
      id: 'app1',
      name: 'Jira',
      vendor: 'Atlassian',
      description: 'tracker',
    });
  });
});
