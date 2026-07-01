import {
  projectApplication,
  projectArticle,
  projectAsset,
  projectConsumable,
  projectInfraNode,
  projectLocation,
  projectUser,
  type AssetRow,
  type ConsumableRow,
  type InfraNodeRow,
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

  it('projectArticle keeps id/slug/title/excerpt/status/content/categoryId (content searchable — ADR-0042; categoryId filterable — ADR-0060)', () => {
    expect(
      projectArticle({
        id: 'art1',
        slug: 'vpn-guide',
        title: 'VPN Guide',
        excerpt: 'how to vpn',
        status: 'PUBLISHED',
        content: '## Step 1\nOpen the VPN client and connect to the gateway.',
        categoryId: 'folder1',
      }),
    ).toEqual({
      id: 'art1',
      slug: 'vpn-guide',
      title: 'VPN Guide',
      excerpt: 'how to vpn',
      status: 'PUBLISHED',
      content: '## Step 1\nOpen the VPN client and connect to the gateway.',
      categoryId: 'folder1',
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

  it('projectInfraNode keeps id/label/kind/status/state/ipAddress + joined assetName (ADR-0070 v1), dropping blobs/secrets', () => {
    // A wider row (the loose `specs`/`shortcuts` blobs the full node carries) assigned to InfraNodeRow,
    // to prove the projector copies only the searchable/filterable subset and NEVER a secret/blob.
    const row: InfraNodeRow & Record<string, unknown> = {
      id: 'n1',
      label: 'web-01',
      kind: 'VM',
      status: 'ONLINE',
      state: 'CONFIRMED',
      ipAddress: '10.0.0.5',
      asset: { name: 'srv-prod-01' },
      // Fields that must NOT leak into the index:
      specs: { ['{{ lazyit_secret.DB_PASS }}']: 'never-index-this' },
      shortcuts: [{ label: 'ssh', url: 'ssh://x' }],
      deletedAt: null,
    };
    const doc = projectInfraNode(row);
    expect(doc).toEqual({
      id: 'n1',
      label: 'web-01',
      kind: 'VM',
      status: 'ONLINE',
      state: 'CONFIRMED',
      ipAddress: '10.0.0.5',
      assetName: 'srv-prod-01', // the linked asset NAME is joined in (a label, never a secret)
    });
    // Explicit: no specs/shortcuts/secret material crossed into the search document.
    expect(doc).not.toHaveProperty('specs');
    expect(doc).not.toHaveProperty('shortcuts');
    expect(JSON.stringify(doc)).not.toContain('lazyit_secret');
  });

  it('projectConsumable keeps id/name/sku/description/currentStock/unit and nothing else (#873)', () => {
    // A wider row (extra columns the full Prisma consumable carries) assigned to ConsumableRow, to
    // prove the projector copies only the searchable/preview subset and drops everything else.
    const row: ConsumableRow & Record<string, unknown> = {
      id: 'k1',
      name: 'HDMI cable',
      sku: 'HDMI-2M',
      description: '2m HDMI 2.1 cable',
      currentStock: 12,
      unit: 'units',
      categoryId: 'cat1',
      minStock: 5,
      notes: 'shelf B',
      deletedAt: null,
    };
    expect(projectConsumable(row)).toEqual({
      id: 'k1',
      name: 'HDMI cable',
      sku: 'HDMI-2M',
      description: '2m HDMI 2.1 cable',
      currentStock: 12,
      unit: 'units',
    });
  });

  it('projectConsumable passes nullable fields through as null (#873)', () => {
    expect(
      projectConsumable({
        id: 'k2',
        name: 'Dock',
        sku: null,
        description: null,
        currentStock: 0,
        unit: 'units',
      }),
    ).toEqual({
      id: 'k2',
      name: 'Dock',
      sku: null,
      description: null,
      currentStock: 0,
      unit: 'units',
    });
  });

  it('projectInfraNode passes a graph-only node (no asset) through with assetName null', () => {
    expect(
      projectInfraNode({
        id: 'n2',
        label: 'redis',
        kind: 'CONTAINER',
        status: 'UNKNOWN',
        state: 'CONFIRMED',
        ipAddress: null,
        asset: null,
      }),
    ).toEqual({
      id: 'n2',
      label: 'redis',
      kind: 'CONTAINER',
      status: 'UNKNOWN',
      state: 'CONFIRMED',
      ipAddress: null,
      assetName: null,
    });
  });
});
