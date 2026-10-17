import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@lazyit/shared';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ArticleImportService } from './import/article-import.service';
import { visibleFolderPath } from './article-export';
import { FolderAccessService } from '../article-categories/folder-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { RolesGuard } from '../auth/roles.guard';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { keysetBatches } from '../common/export/keyset';
import {
  csvHeader,
  csvRows,
  inMemoryDelegate,
  splitsATie,
} from '../common/in-memory-where.harness-spec';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const USER = {
  admin: 'aaaaaaaa-0000-4000-8000-000000000001',
  alice: 'aaaaaaaa-0000-4000-8000-000000000002',
  bob: 'aaaaaaaa-0000-4000-8000-000000000003',
  vic: 'aaaaaaaa-0000-4000-8000-000000000004',
  gone: 'aaaaaaaa-0000-4000-8000-000000000005',
};
const ROLE: Record<string, Role> = {
  [USER.admin]: 'ADMIN',
  [USER.alice]: 'MEMBER',
  [USER.bob]: 'MEMBER',
  [USER.vic]: 'VIEWER',
};

const FOLDER = {
  ops: 'ckfolderops0000000000001',
  linux: 'ckfolderlinux00000000002',
  secret: 'ckfoldersecret0000000003',
};
const SECRET_FOLDER_NAME = 'HR Secret';
const FOLDERS = [
  { id: FOLDER.ops, parentId: null, name: 'Ops', accessRules: null },
  { id: FOLDER.linux, parentId: FOLDER.ops, name: 'Linux', accessRules: null },
  {
    id: FOLDER.secret,
    parentId: FOLDER.ops,
    name: SECRET_FOLDER_NAME,
    accessRules: [{ kind: 'users', userIds: [USER.bob] }],
  },
].map((f) => ({ ...f, deletedAt: null }));

const AUTHORS: Record<
  string,
  { firstName: string; lastName: string; deletedAt: Date | null }
> = {
  [USER.alice]: { firstName: 'Alice', lastName: 'Author', deletedAt: null },
  [USER.bob]: { firstName: 'Bob', lastName: 'Builder', deletedAt: null },
  [USER.gone]: {
    firstName: 'Gina',
    lastName: 'Gone',
    deletedAt: new Date(Date.UTC(2026, 3, 1)),
  },
};

const BODY_MARKER = 'BODY-NEVER-EXPORTED';
const EXCERPT_MARKER = 'EXCERPT-NEVER-EXPORTED';

let seq = 0;
function article(
  key: string,
  over: {
    status: 'DRAFT' | 'PUBLISHED';
    categoryId: string;
    authorId: string;
    links?: number;
    deletedAt?: Date | null;
  },
) {
  seq += 1;
  return {
    id: `ckarticle${String(seq).padStart(15, '0')}`,
    key,
    slug: `article-${key}`,
    title: `Article ${key}`,
    content: `# ${key}\n\n${BODY_MARKER} ${key}`,
    excerpt: `${EXCERPT_MARKER} ${key}`,
    status: over.status,
    categoryId: over.categoryId,
    authorId: over.authorId,
    lastEditedById: over.authorId,
    publishedAt:
      over.status === 'PUBLISHED' ? new Date(Date.UTC(2026, 1, seq)) : null,
    metadata: null,
    readingMinutes: seq,
    // Pairs share a createdAt; the batch-of-2 walk below splits one across a batch boundary.
    createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(seq / 2))),
    updatedAt: new Date(Date.UTC(2026, 2, seq)),
    deletedAt: over.deletedAt ?? null,
    author: AUTHORS[over.authorId],
    _count: { links: over.links ?? 0 },
  };
}

const ARTICLES = [
  article('pubOps', {
    status: 'PUBLISHED',
    categoryId: FOLDER.ops,
    authorId: USER.alice,
  }),
  article('pubLinux', {
    status: 'PUBLISHED',
    categoryId: FOLDER.linux,
    authorId: USER.bob,
    links: 2,
  }),
  article('pubSecret', {
    status: 'PUBLISHED',
    categoryId: FOLDER.secret,
    authorId: USER.bob,
  }),
  article('aliceDraft', {
    status: 'DRAFT',
    categoryId: FOLDER.linux,
    authorId: USER.alice,
  }),
  article('bobDraft', {
    status: 'DRAFT',
    categoryId: FOLDER.ops,
    authorId: USER.bob,
  }),
  article('bobSecretDraft', {
    status: 'DRAFT',
    categoryId: FOLDER.secret,
    authorId: USER.bob,
  }),
  article('archived', {
    status: 'PUBLISHED',
    categoryId: FOLDER.ops,
    authorId: USER.alice,
    deletedAt: new Date(Date.UTC(2026, 4, 1)),
  }),
  article('formerAuthor', {
    status: 'PUBLISHED',
    categoryId: FOLDER.ops,
    authorId: USER.gone,
  }),
];
const idOf = (key: string) => ARTICLES.find((a) => a.key === key)!.id;
const keysOf = (ids: string[]) =>
  ids.map((id) => ARTICLES.find((a) => a.id === id)!.key).sort();

const SA_ID = 'cksaexport00000000000001';

@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    const sa = req.headers['x-test-sa'];
    if (sa !== undefined) {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: SA_ID, name: 'Exporter' },
        permissions: new Set(sa.split(',').filter(Boolean) as Permission[]),
      };
      return true;
    }
    const id = req.headers['x-test-user'];
    const u = { id, role: ROLE[id] };
    req.user = u;
    req.principal = { kind: 'human', user: u };
    return true;
  }
}

type Caller = { user: string } | { sa: string };

describe('GET /articles/export (ADR-0103, folder ACL ADR-0060, drafts ADR-0022)', () => {
  let app: INestApplication;
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    article: inMemoryDelegate(ARTICLES, { softDelete: true }),
    articleCategory: inMemoryDelegate(FOLDERS, { softDelete: true }),
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
    dataExportLog: { create: auditCreate },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ArticlesController],
      providers: [
        Reflector,
        ArticlesService,
        FolderAccessService,
        ExportService,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: {} },
        { provide: ArticleImportService, useValue: {} },
        // The limiter is the engine's; these specs reuse one identity per role across many exports.
        {
          provide: ExportLimiter,
          useValue: { acquire: () => () => undefined },
        },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => auditCreate.mockClear());

  function get(path: string, caller: Caller) {
    const req = request(app.getHttpServer()).get(path);
    return 'sa' in caller
      ? req.set('X-Test-SA', caller.sa)
      : req.set('X-Test-User', caller.user);
  }

  async function listIds(caller: Caller, query: string): Promise<string[]> {
    const res = await get(`/articles?limit=200&${query}`, caller);
    expect(res.status).toBe(200);
    return (res.body as { items: { id: string }[] }).items.map((a) => a.id);
  }

  function exportCsv(caller: Caller, query: string) {
    return get(`/articles/export?${query}`, caller);
  }

  async function exportedIds(caller: Caller, query: string) {
    const res = await exportCsv(caller, query);
    expect(res.status).toBe(200);
    return csvRows(res.text).map((cells) => cells[0]);
  }

  const alice = { user: USER.alice };
  const bob = { user: USER.bob };
  const admin = { user: USER.admin };
  const vic = { user: USER.vic };

  it('pins the header: index metadata only, no body or excerpt column', async () => {
    const res = await exportCsv(admin, '');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-articles-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csvHeader(res.text)).toBe(
      'ID,Title,Slug,Status,Folder,Author,Links,Reading minutes,Created,Updated,Published',
    );
  });

  it.each([
    ['admin', admin],
    ['bob', bob],
    ['alice', alice],
  ] as const)(
    "no cell of %s's file carries article body or excerpt text",
    async (_label, caller) => {
      const res = await exportCsv(caller, '');
      expect(csvRows(res.text).length).toBeGreaterThan(0);
      expect(res.text).not.toContain(BODY_MARKER);
      expect(res.text).not.toContain(EXCERPT_MARKER);
    },
  );

  it.each([
    ['a VIEWER reader', vic, ''],
    ['a reader every folder admits (bob)', bob, ''],
    ['bob in the restricted folder', bob, `categoryId=${FOLDER.secret}`],
    [
      'bob on a subtree',
      bob,
      `categoryId=${FOLDER.ops}&includeSubfolders=true`,
    ],
    ['a folder-restricted MEMBER (alice)', alice, ''],
    [
      'alice on the subtree holding the hidden folder',
      alice,
      `categoryId=${FOLDER.ops}&includeSubfolders=true`,
    ],
    ['alice on her drafts', alice, 'status=DRAFT'],
    ['alice by author and text', alice, `authorId=${USER.bob}&q=linux`],
    ['an ADMIN', admin, ''],
    ['an ADMIN on drafts and published', admin, 'status=DRAFT,PUBLISHED'],
    ['a service account with article:read', { sa: 'article:read' }, ''],
  ] as const)(
    '%s with "%s": the export holds exactly the ids the list returns',
    async (_label, caller: Caller, query) => {
      const listed = await listIds(caller, query);
      expect(listed.length).toBeGreaterThan(0);
      const exported = await exportedIds(caller, query);
      expect(new Set(exported)).toEqual(new Set(listed));
      expect(exported).toHaveLength(listed.length);
    },
  );

  describe('folder ACL (ADR-0060 §4)', () => {
    it("a folder-restricted user's file holds no article of the hidden folder", async () => {
      const keys = keysOf(await exportedIds(alice, ''));
      expect(keys).toEqual([
        'aliceDraft',
        'formerAuthor',
        'pubLinux',
        'pubOps',
      ]);
      expect(keys).not.toContain('pubSecret');
      expect(keys).not.toContain('bobSecretDraft');
    });

    it('filtering by the hidden folder id is empty in the list and the export alike', async () => {
      const query = `categoryId=${FOLDER.secret}`;
      expect(await listIds(alice, query)).toEqual([]);
      const res = await exportCsv(alice, query);
      expect(res.status).toBe(200);
      expect(csvRows(res.text)).toEqual([]);
      expect(auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resource: 'ARTICLES',
          rowCount: 0,
        }) as unknown,
      });
    });

    it('never names a folder the caller cannot read, while the reader admitted sees it', async () => {
      const aliceFile = (await exportCsv(alice, '')).text;
      expect(aliceFile).not.toContain(SECRET_FOLDER_NAME);
      expect(aliceFile).not.toContain(FOLDER.secret);
      const bobRows = csvRows((await exportCsv(bob, '')).text);
      const secretRow = bobRows.find((c) => c[0] === idOf('pubSecret'))!;
      expect(secretRow[4]).toBe(`Ops / ${SECRET_FOLDER_NAME}`);
    });

    it('a service account sees PUBLIC folders only and, without category:read, folder ids', async () => {
      const sa = { sa: 'article:read' };
      const rows = csvRows((await exportCsv(sa, '')).text);
      expect(keysOf(rows.map((c) => c[0]))).toEqual([
        'formerAuthor',
        'pubLinux',
        'pubOps',
      ]);
      expect(rows.find((c) => c[0] === idOf('pubLinux'))![4]).toBe(
        FOLDER.linux,
      );
    });
  });

  describe('draft visibility (ADR-0022)', () => {
    it("a non-manager's file holds their own drafts and no foreign one", async () => {
      const keys = keysOf(await exportedIds(alice, ''));
      expect(keys).toContain('aliceDraft');
      expect(keys).not.toContain('bobDraft');
      expect(keys).not.toContain('bobSecretDraft');
    });

    it("bob's file holds his drafts, including the one in the restricted folder, and not alice's", async () => {
      const keys = keysOf(await exportedIds(bob, ''));
      expect(keys).toEqual([
        'bobDraft',
        'bobSecretDraft',
        'formerAuthor',
        'pubLinux',
        'pubOps',
        'pubSecret',
      ]);
    });

    it('a manager (ADMIN) gets the list rows: foreign drafts stay out, as in the list (AUD-086 is by link only)', async () => {
      const listed = await listIds(admin, 'status=DRAFT');
      const exported = await exportedIds(admin, 'status=DRAFT');
      expect(listed).toEqual([]);
      expect(exported).toEqual([]);
    });
  });

  describe('soft delete', () => {
    it('an archived article is in no file', async () => {
      for (const caller of [admin, alice, bob]) {
        expect(await exportedIds(caller, '')).not.toContain(idOf('archived'));
      }
    });

    it('the export ignores deleted=only: it walks the live rows the list returns, never an archived one', async () => {
      const live = await listIds(admin, '');
      const exported = await exportedIds(admin, 'deleted=only');
      expect(new Set(exported)).toEqual(new Set(live));
      expect(exported).not.toContain(idOf('archived'));
    });

    it('the list serves deleted=only to an ADMIN only (#1647)', async () => {
      expect((await get('/articles?deleted=only', alice)).status).toBe(403);
      expect(await listIds(admin, 'deleted=only')).toEqual([idOf('archived')]);
    });
  });

  it('renders the folder path, the author (a former member flagged), counts and dates', async () => {
    const rows = csvRows((await exportCsv(bob, '')).text);
    const linux = rows.find((c) => c[0] === idOf('pubLinux'))!;
    const a = ARTICLES.find((x) => x.key === 'pubLinux')!;
    expect(linux).toEqual([
      a.id,
      'Article pubLinux',
      'article-pubLinux',
      'PUBLISHED',
      'Ops / Linux',
      'Bob Builder',
      '2',
      String(a.readingMinutes),
      a.createdAt.toISOString(),
      a.updatedAt.toISOString(),
      a.publishedAt!.toISOString(),
    ]);
    const former = rows.find((c) => c[0] === idOf('formerAuthor'))!;
    expect(former[5]).toBe('Gina Gone (former member)');
    const draft = rows.find((c) => c[0] === idOf('bobDraft'))!;
    expect(draft[3]).toBe('DRAFT');
    expect(draft[10]).toBe('');
  });

  it('audits the export as ARTICLES with its filters and the pre-count', async () => {
    await exportCsv(alice, `status=DRAFT&categoryId=${FOLDER.linux}`);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: USER.alice,
        resource: 'ARTICLES',
        filters: {
          categoryId: [FOLDER.linux],
          status: ['DRAFT'],
          includeSubfolders: false,
        },
        rowCount: 1,
      }) as unknown,
    });
  });

  it('rejects a bad filter with 400, like the list, before any audit row', async () => {
    expect((await exportCsv(alice, 'status=ARCHIVED')).status).toBe(400);
    expect((await exportCsv(alice, 'categoryId=not-a-cuid')).status).toBe(400);
    expect((await exportCsv(alice, 'linked=maybe')).status).toBe(400);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a caller without article:read, like the list, before any audit row', async () => {
    const bare = { sa: 'asset:read' };
    expect((await exportCsv(bare, '')).status).toBe(403);
    expect((await get('/articles', bare)).status).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('exportSource walked in batches of 2 sends every visible article once', async () => {
    const service = app.get(ArticlesService);
    const source = await service.exportSource(
      {},
      {
        id: USER.bob,
        role: 'MEMBER',
      } as never,
      { kind: 'human', user: { id: USER.bob, role: 'MEMBER' } } as never,
    );
    const batches: { id: string; createdAt: Date }[][] = [];
    for await (const batch of keysetBatches(source.fetchBatch, 2)) {
      batches.push(batch);
    }
    const sent = batches.flat().map((a) => a.id);
    expect(sent).toHaveLength(new Set(sent).size);
    expect(keysOf(sent)).toEqual(keysOf(await exportedIds(bob, '')));
    expect(await source.count()).toBe(sent.length);
    expect(batches.length).toBeGreaterThan(1);
    expect(splitsATie(batches)).toBe(true);
  });
});

describe('visibleFolderPath', () => {
  const byId = new Map(
    [
      { id: 'root', parentId: null, name: 'Root' },
      { id: 'mid', parentId: 'root', name: 'Mid' },
      { id: 'leaf', parentId: 'mid', name: 'Leaf' },
      { id: 'loop', parentId: 'loop', name: 'Loop' },
    ].map((f) => [f.id, f]),
  );

  it('walks up to the root for a caller who reads every folder', () => {
    expect(visibleFolderPath('leaf', byId, 'ALL')).toBe('Root / Mid / Leaf');
  });

  it('stops at the first folder the caller cannot read, never naming it or anything above', () => {
    expect(visibleFolderPath('leaf', byId, new Set(['leaf', 'root']))).toBe(
      'Leaf',
    );
    expect(visibleFolderPath('leaf', byId, new Set(['mid', 'root']))).toBe('');
  });

  it('ends on a missing (archived) parent and on a parent loop', () => {
    expect(visibleFolderPath('gone', byId, 'ALL')).toBe('');
    expect(visibleFolderPath('loop', byId, 'ALL')).toBe('Loop');
  });
});
