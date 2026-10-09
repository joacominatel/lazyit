import { expandFolderSubtrees, type FolderTreeEdge } from './folder-tree';

// root ─┬─ a ── a1 ── a1x
//       └─ b
// other (a separate root)
const TREE: FolderTreeEdge[] = [
  { id: 'root', parentId: null },
  { id: 'a', parentId: 'root' },
  { id: 'a1', parentId: 'a' },
  { id: 'a1x', parentId: 'a1' },
  { id: 'b', parentId: 'root' },
  { id: 'other', parentId: null },
];

describe('expandFolderSubtrees (#1539)', () => {
  it('expands a folder to itself plus every descendant at every depth', () => {
    expect(expandFolderSubtrees(['root'], TREE)).toEqual([
      'root',
      'a',
      'b',
      'a1',
      'a1x',
    ]);
  });

  it('expands a mid-tree folder to its own subtree only (never a sibling or ancestor)', () => {
    expect(expandFolderSubtrees(['a'], TREE)).toEqual(['a', 'a1', 'a1x']);
  });

  it('a leaf expands to just itself', () => {
    expect(expandFolderSubtrees(['b'], TREE)).toEqual(['b']);
  });

  it('unions several roots and de-duplicates overlapping subtrees', () => {
    const ids = expandFolderSubtrees(['a', 'root', 'other'], TREE);
    expect(ids).toEqual(['a', 'root', 'other', 'a1', 'b', 'a1x']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps a root that is absent from the folder list (it simply has no descendants)', () => {
    expect(expandFolderSubtrees(['gone'], TREE)).toEqual(['gone']);
  });

  it('does not reach past a folder missing from the list — a soft-deleted folder cuts off its subtree', () => {
    // The caller passes LIVE folders only: with `a1` soft-deleted it is not in the list, so neither it
    // nor `a1x` (still pointing at it) is reached from `root`.
    const live = TREE.filter((f) => f.id !== 'a1');
    expect(expandFolderSubtrees(['root'], live)).toEqual(['root', 'a', 'b']);
  });

  it('does not expand a root that is not live — a child restored under a soft-deleted parent is not reached', () => {
    // `a1` is soft-deleted (absent from the live list) but `a1x` was restored under it: asking for `a1`
    // keeps the root id (it matches no live article) and never walks to its live child.
    const live = TREE.filter((f) => f.id !== 'a1');
    expect(expandFolderSubtrees(['a1'], live)).toEqual(['a1']);
  });

  it('is cycle-safe: a corrupt parentId loop terminates and yields each folder once', () => {
    const cyclic: FolderTreeEdge[] = [
      { id: 'x', parentId: 'z' },
      { id: 'y', parentId: 'x' },
      { id: 'z', parentId: 'y' },
      { id: 'self', parentId: 'self' },
    ];
    expect(expandFolderSubtrees(['x'], cyclic)).toEqual(['x', 'y', 'z']);
    expect(expandFolderSubtrees(['self'], cyclic)).toEqual(['self']);
  });

  it('returns an empty list for no roots', () => {
    expect(expandFolderSubtrees([], TREE)).toEqual([]);
  });
});
