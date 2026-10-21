// Unit tests for promotion-autoclose.mjs (#1666). Run: bun test ./.github/scripts
import { describe, expect, test } from 'bun:test';
import {
  CLOSING_KEYWORDS,
  closingComment,
  landingCommits,
  parseClosingRefs,
  parseLog,
  planClosures,
  prNumberFromSubject,
  run,
  stripNonProse,
} from './promotion-autoclose.mjs';

const REPO = 'joacominatel/lazyit';
const sha = (n) => String(n).padStart(40, '0').replace(/^0/, 'a');

describe('parseClosingRefs', () => {
  test('every GitHub keyword, any case, with or without a colon', () => {
    CLOSING_KEYWORDS.forEach((kw, i) => {
      expect(parseClosingRefs(`${kw} #${i + 1}`, REPO).numbers).toEqual([i + 1]);
      expect(parseClosingRefs(`${kw.toUpperCase()}: #${i + 1}`, REPO).numbers).toEqual([i + 1]);
    });
    expect(parseClosingRefs('Closes:#7', REPO).numbers).toEqual([7]);
  });

  test('several references, deduped, first-seen order', () => {
    const body = 'Closes #10, fixes #3 and resolves #10.\nAlso Fixed #42';
    expect(parseClosingRefs(body, REPO).numbers).toEqual([10, 3, 42]);
  });

  test('a bare mention or a non-keyword is not a closing reference', () => {
    expect(parseClosingRefs('Refs #5, see #6, part of #7, related to #8', REPO).numbers).toEqual([]);
    expect(parseClosingRefs('unfixed #3 · prefixes #4 · closesafe #5', REPO).numbers).toEqual([]);
    expect(parseClosingRefs('Closes #12abc and Fixes #', REPO).numbers).toEqual([]);
  });

  test('only the first reference after a keyword counts, like GitHub', () => {
    expect(parseClosingRefs('Fixes #1, #2', REPO).numbers).toEqual([1]);
  });

  test('same-repo owner/repo form counts; another repository is reported, not closed', () => {
    const r = parseClosingRefs('Closes JoacoMinatel/LazyIT#9 and fixes octo-org/octo-repo#100', REPO);
    expect(r.numbers).toEqual([9]);
    expect(r.foreign).toEqual(['octo-org/octo-repo#100']);
  });

  test('HTML comments, fenced and inline code are ignored', () => {
    const body = [
      'Closes #1',
      '<!-- Closes #2 -->',
      '```sh',
      'gh pr create --body "Closes #3"',
      '```',
      'Write `Closes #4` in the body.',
      '~~~',
      'fixes #5',
      '~~~',
      'Resolves #6',
    ].join('\n');
    expect(parseClosingRefs(body, REPO).numbers).toEqual([1, 6]);
  });

  test('the PR template placeholder closes nothing', () => {
    expect(parseClosingRefs('Closes #<!-- issue number -->', REPO).numbers).toEqual([]);
  });

  test('null and empty bodies', () => {
    expect(parseClosingRefs(null, REPO)).toEqual({ numbers: [], foreign: [] });
    expect(parseClosingRefs('', REPO)).toEqual({ numbers: [], foreign: [] });
  });
});

describe('stripNonProse', () => {
  test('an unterminated comment or fence swallows the rest, never more prose than that', () => {
    expect(stripNonProse('a <!-- b')).toBe('a  ');
    expect(stripNonProse('a\n```\nCloses #1')).not.toContain('#1');
  });
});

describe('prNumberFromSubject', () => {
  test('merge commit and squash subjects', () => {
    expect(prNumberFromSubject('Merge pull request #1655 from joacominatel/fix/issue-1644-x')).toBe(1655);
    expect(prNumberFromSubject('fix(api): something (#1601)')).toBe(1601);
    // The edited merge message names the PR first and the issue last — the PR wins.
    expect(prNumberFromSubject('Merge pull request #1527: record pages (#1525)')).toBe(1527);
  });
  test('anything else has no candidate', () => {
    expect(prNumberFromSubject("Merge remote-tracking branch 'origin/dev' into feat/x")).toBeNull();
    expect(prNumberFromSubject('fix(web): a direct push')).toBeNull();
    expect(prNumberFromSubject('fix(web): mentions (#12) mid-subject only')).toBeNull();
  });
});

describe('parseLog and landingCommits', () => {
  const log = [
    `${sha(1)}\tMerge pull request #20 from o/feat/a`,
    `${sha(2)}\tfeat: work commit on a branch (#19)`,
    `${sha(3)}\tMerge pull request #21: stacked into a feature branch (#7)`,
    `${sha(4)}\tfix: direct push to dev`,
    'not-a-sha\tgarbage',
  ].join('\n');

  test('drops malformed lines', () => {
    expect(parseLog(log).map((c) => c.sha)).toEqual([sha(1), sha(2), sha(3), sha(4)]);
  });

  test('keeps first-parent commits and off-line PR merges, not branch work commits', () => {
    const landing = landingCommits(parseLog(log), new Set([sha(1), sha(4)]));
    expect(landing).toEqual([
      { sha: sha(1), subject: 'Merge pull request #20 from o/feat/a', candidate: 20 },
      { sha: sha(3), subject: 'Merge pull request #21: stacked into a feature branch (#7)', candidate: 21 },
      { sha: sha(4), subject: 'fix: direct push to dev', candidate: null },
    ]);
  });
});

describe('planClosures', () => {
  test('folds PRs into issue → delivering PRs, ignoring the promotion itself', () => {
    const plan = planClosures(
      [
        { number: 10, body: 'Closes #1' },
        { number: 11, body: 'Fixes #1\nCloses #2\nCloses other/repo#3' },
        { number: 99, body: 'Closes #50' },
      ],
      REPO,
      99,
    );
    expect([...plan.issues.entries()]).toEqual([
      [1, [10, 11]],
      [2, [11]],
    ]);
    expect(plan.foreign).toEqual([{ pr: 11, ref: 'other/repo#3' }]);
  });

  test('the comment names the delivering PRs and the promotion', () => {
    expect(closingComment({ deliveredBy: [10, 11], promotion: 99 })).toContain('#10, #11');
    expect(closingComment({ deliveredBy: [10], promotion: 99 })).toContain('#99');
  });
});

// ── run(): a fake Octokit + fake git ────────────────────────────────────────────────────────────

const MERGE = sha(900);
const HEAD = sha(800);

function fixture({ promotion = {}, issues = {}, pulls = {}, failUpdate = [] } = {}) {
  const calls = { comments: [], updates: [], assoc: [] };
  const promo = {
    number: 99,
    merged_at: '2026-10-21T00:00:00Z',
    merge_commit_sha: MERGE,
    base: { ref: 'master' },
    head: { ref: 'dev', sha: HEAD, repo: { full_name: REPO } },
    ...promotion,
  };
  const allPulls = { 99: promo, ...pulls };
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'master' } }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          calls.assoc.push(commit_sha);
          return { data: Object.values(allPulls).filter((p) => p.merge_commit_sha === commit_sha) };
        },
      },
      pulls: {
        get: async ({ pull_number }) => {
          if (!allPulls[pull_number]) throw new Error('Not Found');
          return { data: allPulls[pull_number] };
        },
      },
      issues: {
        get: async ({ issue_number }) => {
          if (!issues[issue_number]) throw new Error('Not Found');
          return { data: issues[issue_number] };
        },
        createComment: async (args) => {
          calls.comments.push(args);
        },
        update: async (args) => {
          if (failUpdate.includes(args.issue_number)) throw new Error('boom');
          calls.updates.push(args);
        },
      },
    },
  };
  const logs = [];
  const log = { info: (m) => logs.push(m), warning: (m) => logs.push(`WARN ${m}`) };
  return { github, calls, logs, log };
}

const pr = (number, mergeSha, body, extra = {}) => ({
  number,
  merged_at: '2026-10-20T00:00:00Z',
  merge_commit_sha: mergeSha,
  base: { ref: 'dev' },
  body,
  ...extra,
});

function gitFake(all, firstParent) {
  const seen = [];
  const fn = async (args) => {
    seen.push(args);
    const list = args.includes('--first-parent') ? firstParent : all;
    return list.map(([s, subject]) => `${s}\t${subject}`).join('\n');
  };
  fn.seen = seen;
  return fn;
}

describe('run', () => {
  const commits = [
    [sha(1), 'Merge pull request #10 from o/feat/a'],
    [sha(2), 'feat: a (#10)'],
    [sha(3), 'Merge pull request #11 from o/fix/b'],
    [sha(4), 'fix: a direct push'],
    [sha(5), 'Merge pull request #12 from o/lies'],
  ];
  const firstParent = [commits[0], commits[2], commits[3], commits[4]];
  const pulls = {
    10: pr(10, sha(1), 'Closes #1\nFixes #2'),
    11: pr(11, sha(3), 'Closes #3, resolves #4, fixes #5\nCloses #6'),
    // #12 exists but its merge commit is elsewhere — the subject at sha(5) is not trusted.
    12: pr(12, sha(777), 'Closes #7'),
  };
  const issues = {
    1: { number: 1, state: 'open' },
    2: { number: 2, state: 'closed' },
    3: { number: 3, state: 'open', pull_request: {} },
    4: { number: 4, state: 'open' },
    5: { number: 5, state: 'open' },
    // #6 does not exist → an error that must not stop the others
    7: { number: 7, state: 'open' },
  };

  test('dry run plans, changes nothing and logs every decision', async () => {
    const f = fixture({ pulls, issues });
    const git = gitFake(commits, firstParent);
    const out = await run({ github: f.github, repo: { owner: 'joacominatel', repo: 'lazyit' }, promotion: 99, dryRun: true, git, log: f.log });
    expect(out.prs).toEqual([10, 11]);
    expect(out.wouldClose).toEqual([1, 4, 5]);
    expect(out.closed).toEqual([]);
    expect(out.failed).toEqual([6]);
    expect(f.calls.comments).toEqual([]);
    expect(f.calls.updates).toEqual([]);
    expect(out.decisions.map((d) => [d.issue, d.action])).toEqual([
      [1, 'would close'],
      [2, 'skip'],
      [3, 'skip'],
      [4, 'would close'],
      [5, 'would close'],
      [6, 'error'],
    ]);
    // The range is the promotion head minus the default branch before the merge, argv only.
    expect(git.seen[0]).toEqual(['log', '--format=%H%x09%s', HEAD, `^${MERGE}^1`, '--']);
    // The direct push and the lying subject fall back to the associated-PRs lookup, and find nothing.
    expect(f.calls.assoc).toEqual([sha(4), sha(5)]);
  });

  test('a real run comments then closes as completed; one failure does not stop the rest', async () => {
    const f = fixture({ pulls, issues, failUpdate: [4] });
    const out = await run({ github: f.github, repo: { owner: 'joacominatel', repo: 'lazyit' }, promotion: 99, dryRun: false, git: gitFake(commits, firstParent), log: f.log });
    expect(out.closed).toEqual([1, 5]);
    expect(out.failed).toEqual([4, 6]);
    expect(f.calls.updates).toEqual([
      { owner: 'joacominatel', repo: 'lazyit', issue_number: 1, state: 'closed', state_reason: 'completed' },
      { owner: 'joacominatel', repo: 'lazyit', issue_number: 5, state: 'closed', state_reason: 'completed' },
    ]);
    expect(f.calls.comments.map((c) => c.issue_number)).toEqual([1, 4, 5]);
    expect(f.calls.comments[0].body).toContain('#10');
    expect(f.calls.comments[0].body).toContain('#99');
  });

  test('refuses anything that is not a merged dev → default-branch promotion from this repo', async () => {
    const repo = { owner: 'joacominatel', repo: 'lazyit' };
    const git = gitFake([], []);
    const go = (promotion, dryRun = false) => {
      const f = fixture({ promotion });
      return run({ github: f.github, repo, promotion: 99, dryRun, git, log: f.log });
    };
    await expect(go({ head: { ref: 'feat/x', sha: HEAD, repo: { full_name: REPO } } })).rejects.toThrow('not a dev');
    await expect(go({ base: { ref: 'dev' } })).rejects.toThrow('not a dev');
    await expect(go({ head: { ref: 'dev', sha: HEAD, repo: { full_name: 'fork/lazyit' } } })).rejects.toThrow('another repository');
    await expect(go({ merged_at: null })).rejects.toThrow('not merged');
  });

  test('an open promotion can be previewed against the current default branch', async () => {
    const f = fixture({ promotion: { merged_at: null, merge_commit_sha: null }, pulls, issues });
    const git = gitFake(commits, firstParent);
    const out = await run({ github: f.github, repo: { owner: 'joacominatel', repo: 'lazyit' }, promotion: 99, dryRun: true, git, log: f.log });
    expect(git.seen[0]).toEqual(['log', '--format=%H%x09%s', HEAD, '^refs/remotes/origin/master', '--']);
    expect(out.wouldClose).toEqual([1, 4, 5]);
  });
});
