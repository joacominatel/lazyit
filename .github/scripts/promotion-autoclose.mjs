// Close the issues a dev → master promotion delivers (#1666).
//
// Our PRs target `dev`, and GitHub honours a closing keyword in a PR body only when that PR merges
// into the default branch. Dev PRs are merged with merge commits whose message carries the PR title,
// not its body, so `Closes #N` never reaches a commit on `master` and the issue stays open forever.
// .github/workflows/promotion-autoclose.yml runs this module when the promotion PR merges.
//
// The pure helpers (parsing, planning) are exported for promotion-autoclose.test.mjs. `run` is the
// orchestrator; every side effect it has goes through the injected `github` (an Octokit client, as
// actions/github-script provides it) and `git` (argv in, stdout out — never a shell).
//
// PR bodies are untrusted input. They are only ever matched with a regular expression here; nothing
// from them reaches a shell, a git argument or an API path except the issue number the regex captured.

// GitHub's closing keywords, case-insensitive, optionally followed by a colon ("Closes: #10").
// Source: docs.github.com → "Linking a pull request to an issue" → "Linking a pull request to an
// issue using a keyword".
export const CLOSING_KEYWORDS = Object.freeze([
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]);

const KEYWORD_ALTERNATION = CLOSING_KEYWORDS.join('|');

// KEYWORD #N  or  KEYWORD OWNER/REPO#N. The keyword must start a word ("unfixed #3" is not a keyword)
// and the number must end one ("#12abc" is not a reference).
const CLOSING_REF = new RegExp(
  `(?<![\\w])(?:${KEYWORD_ALTERNATION})(?:\\s*:\\s*|\\s+)` +
    `(?:([A-Za-z0-9][A-Za-z0-9-]*\\/[A-Za-z0-9._-]+))?#(\\d+)(?![\\w])`,
  'gi',
);

const SHA = /^[0-9a-f]{40}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Drop the parts of a Markdown body that are not prose: HTML comments (the PR template's guidance
 * lives in one), fenced code blocks and inline code. A keyword shown as an example is not an intent
 * to close anything.
 */
export function stripNonProse(markdown) {
  return String(markdown ?? '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g, ' ');
}

/**
 * The issues a body asks to close, for `repoFullName` (owner/repo, case-insensitive).
 * Returns { numbers: number[] (deduped, first-seen order), foreign: string[] (other repositories) }.
 */
export function parseClosingRefs(body, repoFullName) {
  const own = String(repoFullName).toLowerCase();
  const numbers = [];
  const foreign = [];
  for (const match of stripNonProse(body).matchAll(CLOSING_REF)) {
    const [, repo, digits] = match;
    const number = Number(digits);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    if (repo && repo.toLowerCase() !== own) {
      const ref = `${repo}#${number}`;
      if (!foreign.includes(ref)) foreign.push(ref);
      continue;
    }
    if (!numbers.includes(number)) numbers.push(number);
  }
  return { numbers, foreign };
}

/**
 * The PR number a commit subject names: "Merge pull request #N from owner/branch" (GitHub's default
 * merge message), "Merge pull request #N: title (#issue)" (the edited form this repository also uses),
 * or "title (#N)" for a squash. A candidate only — `run` confirms it against the PR's
 * merge_commit_sha, so a subject that lies cannot pull an unrelated PR in.
 */
export function prNumberFromSubject(subject) {
  const s = String(subject ?? '');
  const merge = /^Merge pull request #(\d+)\b/.exec(s);
  if (merge) return Number(merge[1]);
  const squash = /\(#(\d+)\)\s*$/.exec(s);
  if (squash) return Number(squash[1]);
  return null;
}

/** Parse `git log --format=%H%x09%s` output into [{ sha, subject }]. */
export function parseLog(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1
        ? { sha: line.trim(), subject: '' }
        : { sha: line.slice(0, tab).trim(), subject: line.slice(tab + 1) };
    })
    .filter(({ sha }) => SHA.test(sha));
}

/**
 * The commits worth resolving to a PR, given every commit in the promotion (`all`) and dev's own
 * first-parent line (`firstParent`, a Set of shas). A commit on the first-parent line is how work
 * reached dev (a PR's merge or squash commit, or a direct push); a "Merge pull request" commit off it
 * is a PR merged into another branch that then reached dev (a stacked PR). Everything else is a
 * branch's own work commit and is skipped — that keeps the API calls to roughly one per PR.
 */
export function landingCommits(all, firstParent) {
  return all
    .filter(({ sha, subject }) => firstParent.has(sha) || /^Merge pull request #\d+\b/.test(subject))
    .map(({ sha, subject }) => ({ sha, subject, candidate: prNumberFromSubject(subject) }));
}

/**
 * Fold the delivering PRs into one plan: issue number → the PRs that asked to close it.
 * `prs` is [{ number, body }]. The promotion PR itself never counts.
 */
export function planClosures(prs, repoFullName, promotionNumber) {
  const issues = new Map();
  const foreign = [];
  for (const pr of prs) {
    if (pr.number === promotionNumber) continue;
    const refs = parseClosingRefs(pr.body, repoFullName);
    for (const ref of refs.foreign) foreign.push({ pr: pr.number, ref });
    for (const n of refs.numbers) {
      if (!issues.has(n)) issues.set(n, []);
      issues.get(n).push(pr.number);
    }
  }
  return { issues, foreign };
}

export function closingComment({ deliveredBy, promotion }) {
  const prs = deliveredBy.map((n) => `#${n}`).join(', ');
  return (
    `Delivered by ${prs} (merged into \`dev\`) and promoted to the default branch in #${promotion}. ` +
    'Closed automatically by the promotion auto-close workflow (#1666).'
  );
}

/**
 * Resolve the promotion, find the PRs it carries, and close the issues they reference.
 *
 * @param {object} o
 * @param {object} o.github     Octokit (github-script's `github`).
 * @param {{owner: string, repo: string}} o.repo
 * @param {number} o.promotion  The promotion PR number.
 * @param {boolean} o.dryRun    Log the plan, change nothing.
 * @param {(args: string[]) => Promise<string>} o.git   Runs git with argv, returns stdout.
 * @param {{info: Function, warning: Function}} o.log
 * @param {string} [o.headRef='dev']   The promotion's expected head branch.
 * @returns {Promise<{decisions: object[], closed: number[], wouldClose: number[], failed: number[]}>}
 */
export async function run({ github, repo, promotion, dryRun, git, log, headRef = 'dev' }) {
  const fullName = `${repo.owner}/${repo.repo}`;
  const decisions = [];
  const decide = (entry) => {
    decisions.push(entry);
    const line = `#${entry.issue ?? entry.pr ?? '?'} — ${entry.action}: ${entry.reason}`;
    (entry.action === 'error' ? log.warning : log.info)(line);
  };

  const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: promotion });
  const { data: repoData } = await github.rest.repos.get({ ...repo });
  const defaultBranch = repoData.default_branch;

  if (pull.base.ref !== defaultBranch || pull.head.ref !== headRef) {
    throw new Error(
      `#${promotion} is ${pull.head.ref} → ${pull.base.ref}, not a ${headRef} → ${defaultBranch} promotion`,
    );
  }
  if (pull.head.repo?.full_name?.toLowerCase() !== fullName.toLowerCase()) {
    throw new Error(`#${promotion} comes from another repository (${pull.head.repo?.full_name})`);
  }
  if (!pull.merged_at && !dryRun) {
    throw new Error(`#${promotion} is not merged — only a dry run can preview an open promotion`);
  }

  const head = pull.head.sha;
  let base;
  if (pull.merged_at) {
    if (!SHA.test(pull.merge_commit_sha ?? '')) throw new Error(`#${promotion} has no merge commit sha`);
    base = `${pull.merge_commit_sha}^1`; // the default branch just before the promotion landed
  } else {
    if (!SAFE_REF.test(defaultBranch)) throw new Error(`unexpected default branch name ${defaultBranch}`);
    base = `refs/remotes/origin/${defaultBranch}`;
  }
  if (!SHA.test(head)) throw new Error(`#${promotion} has no head sha`);

  const all = parseLog(await git(['log', '--format=%H%x09%s', head, `^${base}`, '--']));
  const firstParent = new Set(
    parseLog(await git(['log', '--first-parent', '--format=%H%x09%s', head, `^${base}`, '--'])).map(
      (c) => c.sha,
    ),
  );
  const landing = landingCommits(all, firstParent);
  log.info(
    `#${promotion}: ${all.length} commits, ${firstParent.size} on ${headRef}'s first-parent line, ` +
      `${landing.length} to resolve to a PR (range ${head.slice(0, 12)} ^${base}).`,
  );

  // Resolve each landing commit to the PR whose merge commit it is.
  const prs = new Map();
  const pullCache = new Map();
  const getPull = async (number) => {
    if (!pullCache.has(number)) {
      pullCache.set(
        number,
        github.rest.pulls.get({ ...repo, pull_number: number }).then(
          (r) => r.data,
          () => null,
        ),
      );
    }
    return pullCache.get(number);
  };
  const accept = (pr, sha) =>
    pr && pr.merged_at && pr.merge_commit_sha === sha && pr.number !== promotion && pr.base.ref !== defaultBranch;

  for (const commit of landing) {
    try {
      let found = null;
      if (commit.candidate) {
        const pr = await getPull(commit.candidate);
        if (accept(pr, commit.sha)) found = pr;
      }
      if (!found) {
        const { data: assoc } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
          ...repo,
          commit_sha: commit.sha,
        });
        found = assoc.find((pr) => accept(pr, commit.sha)) ?? null;
      }
      if (found) {
        if (!prs.has(found.number)) prs.set(found.number, { number: found.number, body: found.body ?? '' });
      } else {
        log.info(`${commit.sha.slice(0, 12)} — no merged PR (direct push?): ${commit.subject}`);
      }
    } catch (err) {
      log.warning(`${commit.sha.slice(0, 12)} — could not resolve to a PR: ${err.message}`);
    }
  }
  log.info(`#${promotion} carries ${prs.size} PRs: ${[...prs.keys()].map((n) => `#${n}`).join(' ')}`);

  const plan = planClosures([...prs.values()], fullName, promotion);
  for (const { pr, ref } of plan.foreign) {
    decide({ pr, action: 'skip', reason: `references ${ref} in another repository` });
  }

  const closed = [];
  const wouldClose = [];
  const failed = [];
  for (const [number, deliveredBy] of [...plan.issues.entries()].sort((a, b) => a[0] - b[0])) {
    const via = deliveredBy.map((n) => `#${n}`).join(', ');
    try {
      const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: number });
      if (issue.pull_request) {
        decide({ issue: number, action: 'skip', reason: `is a pull request (referenced by ${via})` });
        continue;
      }
      if (issue.state === 'closed') {
        decide({ issue: number, action: 'skip', reason: `already closed (referenced by ${via})` });
        continue;
      }
      if (dryRun) {
        wouldClose.push(number);
        decide({ issue: number, action: 'would close', reason: `delivered by ${via}` });
        continue;
      }
      try {
        await github.rest.issues.createComment({
          ...repo,
          issue_number: number,
          body: closingComment({ deliveredBy, promotion }),
        });
      } catch (err) {
        log.warning(`#${number} — comment failed, closing anyway: ${err.message}`);
      }
      await github.rest.issues.update({
        ...repo,
        issue_number: number,
        state: 'closed',
        state_reason: 'completed',
      });
      closed.push(number);
      decide({ issue: number, action: 'closed', reason: `delivered by ${via}` });
    } catch (err) {
      failed.push(number);
      decide({ issue: number, action: 'error', reason: err.message });
    }
  }

  return { decisions, closed, wouldClose, failed, prs: [...prs.keys()] };
}
