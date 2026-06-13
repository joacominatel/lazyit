import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ArticleCategoriesService } from './article-categories.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). `Prisma.DbNull` is
// the sentinel `setAccessRules(null)` writes to clear the jsonb column, so the mock must expose it.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: 'DbNull' },
}));

type CategoryMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  count: jest.Mock;
};

type ArticleMock = {
  count: jest.Mock;
  updateMany: jest.Mock;
  findMany: jest.Mock;
};

type ArticleAliasMock = {
  deleteMany: jest.Mock;
};

describe('ArticleCategoriesService', () => {
  let service: ArticleCategoriesService;
  let articleCategory: CategoryMock;
  let article: ArticleMock;
  let articleAlias: ArticleAliasMock;
  let prisma: {
    articleCategory: CategoryMock;
    article: ArticleMock;
    articleAlias: ArticleAliasMock;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    articleCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    };
    article = {
      count: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    };
    articleAlias = {
      deleteMany: jest.fn(),
    };

    // $transaction: by default, immediately invoke the callback with a tx that mirrors the mocks.
    const txProxy = {
      articleAlias,
      article,
      articleCategory,
    };
    prisma = {
      articleCategory,
      article,
      articleAlias,
      $transaction: jest.fn((callback: (tx: typeof txProxy) => Promise<unknown>) =>
        callback(txProxy),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ArticleCategoriesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(ArticleCategoriesService);
  });

  it('creates a root folder (no parentId → no parent lookup)', async () => {
    const dto = { name: 'Networking', icon: 'GlobeAltIcon' };
    const created = { id: 'c1', ...dto, description: null, order: null };
    articleCategory.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(articleCategory.create).toHaveBeenCalledWith({ data: dto });
    // No parentId → the parent-usable check is skipped entirely.
    expect(articleCategory.findFirst).not.toHaveBeenCalled();
  });

  it('creates a nested folder after confirming the parent is live', async () => {
    const dto = { name: 'Linux', parentId: 'p1' };
    articleCategory.findFirst.mockResolvedValue({ id: 'p1' }); // parent-usable check
    articleCategory.create.mockResolvedValue({ id: 'c2', ...dto });

    await service.create(dto);

    expect(articleCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1' },
      select: { id: true },
    });
    expect(articleCategory.create).toHaveBeenCalledWith({ data: dto });
  });

  it('rejects (400) creating a folder under a non-existent parent', async () => {
    articleCategory.findFirst.mockResolvedValue(null); // parent not live
    await expect(
      service.create({ name: 'Linux', parentId: 'missing' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(articleCategory.create).not.toHaveBeenCalled();
  });

  it('findAll excludes soft-deleted, ordered by order (nulls last) then name', async () => {
    articleCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(articleCategory.findMany).toHaveBeenCalledWith({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
  });

  it('returns a category by id when it exists', async () => {
    const found = { id: 'c1', name: 'Networking', deletedAt: null };
    articleCategory.findFirst.mockResolvedValue(found);

    await expect(service.findOne('c1')).resolves.toEqual(found);
    expect(articleCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  it('throws NotFound when the category does not exist', async () => {
    articleCategory.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes a folder with no live articles and no child folders', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    article.count.mockResolvedValue(0);
    articleCategory.count.mockResolvedValue(0); // no child folders
    articleCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1');

    expect(article.count).toHaveBeenCalledWith({
      where: { categoryId: 'c1' },
    });
    expect(articleCategory.count).toHaveBeenCalledWith({
      where: { parentId: 'c1' },
    });
    const calls = articleCategory.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses (409) to delete a folder that still has live articles', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    article.count.mockResolvedValue(3);

    await expect(service.remove('c1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(articleCategory.update).not.toHaveBeenCalled();
  });

  it('refuses (409) to delete a folder that still has live child folders (no silent orphaning)', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    article.count.mockResolvedValue(0); // no articles
    articleCategory.count.mockResolvedValue(2); // 2 sub-folders

    await expect(service.remove('c1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(articleCategory.update).not.toHaveBeenCalled();
  });

  it('does not soft-delete a missing folder', async () => {
    articleCategory.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(article.count).not.toHaveBeenCalled();
  });

  it('applies a metadata-only update without a parent/cycle check', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    articleCategory.update.mockResolvedValue({ id: 'c1', name: 'Networks' });

    await service.update('c1', { name: 'Networks' });

    expect(articleCategory.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Networks' },
    });
  });

  it('moves a folder to the root (parentId: null) without a parent/cycle check', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    articleCategory.update.mockResolvedValue({ id: 'c1', parentId: null });

    await service.update('c1', { parentId: null });

    // findFirst is only the existence (findOne) call; no parent-usable / cycle walk for a root move.
    expect(articleCategory.findFirst).toHaveBeenCalledTimes(1);
    expect(articleCategory.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { parentId: null },
    });
  });

  describe('folder cycle guard (ADR-0059 §1)', () => {
    /**
     * Drive the move: the first findFirst is the existence check (findOne), the second is the
     * parent-usable check, and the rest are the DFS walk UP the chain. `chain` maps a folder id to
     * its parentId so the walk can be replayed deterministically.
     */
    const wireWalk = (
      subject: { id: string; deletedAt: null },
      parentUsable: { id: string },
      chain: Record<string, string | null>,
    ) => {
      articleCategory.findFirst
        .mockResolvedValueOnce(subject) // findOne existence
        .mockResolvedValueOnce(parentUsable) // assertParentUsable
        .mockImplementation((args: { where: { id: string } }) =>
          Promise.resolve({ parentId: chain[args.where.id] ?? null }),
        );
    };

    it('allows reparenting under an unrelated folder (no cycle)', async () => {
      // A is the subject; move under C whose chain is C -> B -> (root). Never reaches A.
      wireWalk(
        { id: 'A', deletedAt: null },
        { id: 'C' },
        {
          C: 'B',
          B: null,
        },
      );
      articleCategory.update.mockResolvedValue({ id: 'A', parentId: 'C' });

      await service.update('A', { parentId: 'C' });
      expect(articleCategory.update).toHaveBeenCalled();
    });

    it('rejects (400) a move that makes the folder its own ancestor', async () => {
      // Subject A; proposed parent C whose chain is C -> B -> A → closing a cycle.
      wireWalk(
        { id: 'A', deletedAt: null },
        { id: 'C' },
        {
          C: 'B',
          B: 'A',
        },
      );

      await expect(
        service.update('A', { parentId: 'C' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(articleCategory.update).not.toHaveBeenCalled();
    });

    it('rejects (400) a folder set as its own parent', async () => {
      articleCategory.findFirst
        .mockResolvedValueOnce({ id: 'A', deletedAt: null }) // findOne
        .mockResolvedValueOnce({ id: 'A' }); // assertParentUsable

      await expect(
        service.update('A', { parentId: 'A' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(articleCategory.update).not.toHaveBeenCalled();
    });
  });

  describe('setAccessRules (ADR-0060 §3)', () => {
    it('stores a non-null rule list (restricts the folder)', async () => {
      articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
      const rules = [{ kind: 'role' as const, role: 'MEMBER' as const }];
      articleCategory.update.mockResolvedValue({ id: 'c1', accessRules: rules });

      await service.setAccessRules('c1', rules);

      expect(articleCategory.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { accessRules: rules },
      });
    });

    it('clears the restriction (null → Prisma.DbNull, makes the folder PUBLIC again)', async () => {
      articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
      articleCategory.update.mockResolvedValue({ id: 'c1', accessRules: null });

      await service.setAccessRules('c1', null);

      // null clears the jsonb column via the Prisma.DbNull sentinel (writes SQL NULL).
      expect(articleCategory.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { accessRules: 'DbNull' },
      });
    });

    it('404s when the folder is missing or soft-deleted', async () => {
      articleCategory.findFirst.mockResolvedValue(null);
      await expect(service.setAccessRules('missing', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(articleCategory.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // removeCascade — cascade soft-delete (issue #415)
  // ---------------------------------------------------------------------------

  describe('removeCascade', () => {
    /**
     * Wire up the BFS tree walk mock: `findFirst` (findOne existence check) returns the root
     * folder, then `findMany` returns the children at each level as keyed in `childrenMap`.
     * After the tree walk, the $transaction callback fires the tx mocks directly.
     *
     * `childrenMap` maps a folder id to the ids of its DIRECT children. Omit a key (or map it to [])
     * to indicate a leaf.
     */
    const wireTree = (
      rootId: string,
      childrenMap: Record<string, string[]> = {},
    ) => {
      // findOne (existence check) — returns a live folder
      articleCategory.findFirst.mockResolvedValue({
        id: rootId,
        deletedAt: null,
      });

      // BFS findMany calls: each call receives { where: { parentId: X }, select: { id: true }, ... }
      articleCategory.findMany.mockImplementation(
        (args: { where?: { parentId?: string } }) => {
          const pid = args?.where?.parentId;
          const ids = (pid && childrenMap[pid]) ? childrenMap[pid] : [];
          return Promise.resolve(ids.map((id) => ({ id })));
        },
      );
    };

    it('cascade soft-deletes a nested subtree (root > child > grandchild) + all their articles; counts are correct', async () => {
      // Tree: root → child → grandchild
      wireTree('root', { root: ['child'], child: ['gc'] });

      articleAlias.deleteMany.mockResolvedValue({ count: 0 });
      article.updateMany.mockResolvedValue({ count: 5 }); // 5 articles total across subtree
      article.findMany.mockResolvedValue([]); // no article-side aliases to clean
      articleCategory.updateMany.mockResolvedValue({ count: 3 }); // root + child + gc

      const result = await service.removeCascade('root');

      expect(result).toEqual({ deletedFolders: 3, deletedArticles: 5 });

      // The folder-side alias deletion must cover all 3 subtree ids.
      expect(articleAlias.deleteMany).toHaveBeenNthCalledWith(1, {
        where: { folderId: { in: expect.arrayContaining(['root', 'child', 'gc']) } },
      });

      // Articles in the subtree are soft-deleted (deletedAt: null guard in updateMany).
      expect(article.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            categoryId: { in: expect.arrayContaining(['root', 'child', 'gc']) },
            deletedAt: null,
          }),
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );

      // Folders in the subtree are soft-deleted.
      expect(articleCategory.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: expect.arrayContaining(['root', 'child', 'gc']) },
            deletedAt: null,
          }),
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );

      // Rows have deletedAt stamped (same Date instance across all updateMany calls in the tx).
      const articleCall = article.updateMany.mock.calls[0][0] as {
        data: { deletedAt: Date };
      };
      const folderCall = articleCategory.updateMany.mock.calls[0][0] as {
        data: { deletedAt: Date };
      };
      expect(articleCall.data.deletedAt).toBeInstanceOf(Date);
      expect(folderCall.data.deletedAt).toBeInstanceOf(Date);
    });

    it('non-cascade (remove) still 409s when the folder has live children', async () => {
      articleCategory.findFirst.mockResolvedValue({ id: 'f1', deletedAt: null });
      article.count.mockResolvedValue(0);
      articleCategory.count.mockResolvedValue(2); // has 2 children

      await expect(service.remove('f1')).rejects.toBeInstanceOf(ConflictException);
      expect(articleCategory.update).not.toHaveBeenCalled();
    });

    it('non-cascade still 409s when the folder has live articles', async () => {
      articleCategory.findFirst.mockResolvedValue({ id: 'f1', deletedAt: null });
      article.count.mockResolvedValue(1);

      await expect(service.remove('f1')).rejects.toBeInstanceOf(ConflictException);
      expect(articleCategory.update).not.toHaveBeenCalled();
    });

    it('404s on a missing or already-soft-deleted folder', async () => {
      articleCategory.findFirst.mockResolvedValue(null); // findOne returns nothing

      await expect(service.removeCascade('gone')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Transaction must NOT be entered if the root folder is gone.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a descendant article authored by ANOTHER user is soft-deleted by the cascade (ADMIN override)', async () => {
      // Single-level: root has one child folder that has one article authored by 'other-user'.
      wireTree('root', { root: ['child'] });

      articleAlias.deleteMany.mockResolvedValue({ count: 0 });
      // updateMany doesn't care about authorId — it applies to ALL live articles in the subtree.
      article.updateMany.mockResolvedValue({ count: 1 });
      article.findMany.mockResolvedValue([{ id: 'art-by-other' }]);
      // Article-side alias cleanup for the deleted article.
      articleAlias.deleteMany.mockResolvedValue({ count: 1 });
      articleCategory.updateMany.mockResolvedValue({ count: 2 }); // root + child

      const result = await service.removeCascade('root');

      expect(result.deletedArticles).toBe(1);
      // The updateMany has NO authorId filter — confirming the ADMIN bypass.
      const updateCall = article.updateMany.mock.calls[0][0] as {
        where: { categoryId: { in: string[] }; deletedAt: null };
      };
      expect(Object.keys(updateCall.where)).not.toContain('authorId');
    });

    it('alias handling: folder-side aliases in the deleted subtree are hard-deleted', async () => {
      // Leaf folder with one alias pointing at it from OUTSIDE the subtree.
      wireTree('root');

      articleAlias.deleteMany.mockResolvedValue({ count: 1 });
      article.updateMany.mockResolvedValue({ count: 0 });
      article.findMany.mockResolvedValue([]);
      articleCategory.updateMany.mockResolvedValue({ count: 1 });

      await service.removeCascade('root');

      // The FIRST deleteMany call covers folderId-in-subtree aliases.
      expect(articleAlias.deleteMany).toHaveBeenNthCalledWith(1, {
        where: { folderId: { in: ['root'] } },
      });
    });

    it('alias handling: article-side aliases outside the subtree are hard-deleted when their article is soft-deleted', async () => {
      wireTree('root');

      articleAlias.deleteMany.mockResolvedValue({ count: 0 });
      article.updateMany.mockResolvedValue({ count: 2 }); // 2 articles deleted
      // findMany returns the ids of the newly deleted articles.
      article.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
      articleCategory.updateMany.mockResolvedValue({ count: 1 });

      await service.removeCascade('root');

      // The SECOND deleteMany call covers articleId-in-deleted-set aliases.
      expect(articleAlias.deleteMany).toHaveBeenNthCalledWith(2, {
        where: { articleId: { in: ['a1', 'a2'] } },
      });
    });

    it('cascade on an empty folder (no children, no articles) returns { deletedFolders: 1, deletedArticles: 0 }', async () => {
      wireTree('root'); // no children

      articleAlias.deleteMany.mockResolvedValue({ count: 0 });
      article.updateMany.mockResolvedValue({ count: 0 });
      article.findMany.mockResolvedValue([]);
      articleCategory.updateMany.mockResolvedValue({ count: 1 }); // only the root

      const result = await service.removeCascade('root');

      expect(result).toEqual({ deletedFolders: 1, deletedArticles: 0 });
    });

    it('all mutations run inside a single $transaction', async () => {
      wireTree('root', { root: ['child'] });

      articleAlias.deleteMany.mockResolvedValue({ count: 0 });
      article.updateMany.mockResolvedValue({ count: 0 });
      article.findMany.mockResolvedValue([]);
      articleCategory.updateMany.mockResolvedValue({ count: 2 });

      await service.removeCascade('root');

      // $transaction was called exactly once.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // All the side-effecting calls happened through the tx proxy, not the outer prisma mock.
      // (The tx proxy IS the same articleAlias/article/articleCategory mock objects in this test
      // setup, so we simply verify $transaction was the entry point.)
    });
  });
});
