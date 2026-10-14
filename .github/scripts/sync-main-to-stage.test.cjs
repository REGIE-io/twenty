const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { syncMainToStage } = require('./sync-main-to-stage.cjs');

const SHA = 'a'.repeat(40);
const STAGE = 'b'.repeat(40);
const PREFIX = 'codex/promote-main-to-stage-';

function fixture(options = {}) {
  const calls = [];
  const repo = { owner: 'REGIE-io', repo: 'twenty' };
  const run = {
    id: 123,
    html_url: 'https://github.com/REGIE-io/twenty/actions/runs/123',
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: SHA,
    head_repository: { full_name: 'REGIE-io/twenty' },
    path: '.github/workflows/deploy-prod.yml',
    ...options.run,
  };
  const promotion = {
    number: 10,
    node_id: 'PR_10',
    html_url: 'https://github.com/REGIE-io/twenty/pull/10',
    head: {
      ref: PREFIX + SHA,
      sha: SHA,
      repo: { full_name: 'REGIE-io/twenty' },
    },
    labels: [],
    ...options.pr,
  };
  const method = (name, result) => async (args) => {
    calls.push({ name, args });
    return { data: typeof result === 'function' ? result(args) : result };
  };
  const github = {
    rest: {
      git: {
        getRef: method('getRef', ({ ref }) => {
          if (ref === 'heads/main')
            return { object: { sha: options.main ?? SHA } };
          if (ref === 'heads/stage') return { object: { sha: STAGE } };
          if (options.branch) return { object: { sha: options.branch } };
          throw Object.assign(new Error('Missing ref'), { status: 404 });
        }),
        createRef: method('createRef', {}),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: method(
          'sourcePrs',
          options.sourcePrs ?? [],
        ),
        compareCommitsWithBasehead: method('compare', {
          ahead_by: options.ahead ?? 2,
        }),
      },
      pulls: {
        list: method('openPrs', options.openPrs ?? []),
        create: method('createPr', promotion),
        update: method('updatePr', {}),
        merge: method('mergePr', { merged: true }),
      },
      actions: {
        getWorkflowRun: method('getRun', run),
        listWorkflowRunsForRepo: method('ciRuns', options.ciRuns ?? []),
      },
      issues: { addLabels: method('label', {}) },
    },
    paginate: async (fn, args) => (await fn(args)).data,
    graphql: async (query, args) => {
      calls.push({ name: 'autoMerge', args });
    },
  };
  return {
    args: {
      github,
      context: { repo, payload: { workflow_run: run } },
      core: { info() {} },
    },
    calls,
    promotion,
  };
}

const mutations = (calls) =>
  calls.filter((c) =>
    ['createRef', 'createPr', 'updatePr', 'label', 'autoMerge'].includes(
      c.name,
    ),
  );

test('promotes an exact deployed main SHA through a CI-gated PR', async () => {
  const { args, calls } = fixture();
  assert.deepEqual(await syncMainToStage(args), { number: 10, sha: SHA });
  assert.deepEqual(
    mutations(calls).map((c) => c.name),
    ['createRef', 'createPr', 'label', 'autoMerge'],
  );
  assert.equal(calls.find((c) => c.name === 'createRef').args.sha, SHA);
  assert.equal(calls.find((c) => c.name === 'createPr').args.base, 'stage');
  assert.equal(
    calls.find((c) => c.name === 'createPr').args.head,
    PREFIX + SHA,
  );
  assert.deepEqual(calls.find((c) => c.name === 'label').args.labels, [
    'run-ci',
  ]);
});

for (const [name, run] of Object.entries({
  failed: { conclusion: 'failure' },
  manual: { event: 'workflow_dispatch' },
  stage: { head_branch: 'stage' },
  fork: { head_repository: { full_name: 'fork/twenty' } },
  unrelated: { path: '.github/workflows/deploy-dev.yml' },
})) {
  test(`does nothing for ${name} deployment`, async () => {
    const { args, calls } = fixture({ run });
    assert.ok((await syncMainToStage(args)).skipped);
    assert.equal(mutations(calls).length, 0);
  });
}

test('excludes a stage -> main merge even though its production deployment succeeded', async () => {
  const { args, calls } = fixture({
    sourcePrs: [
      {
        merged_at: '2026-10-14T12:00:00Z',
        base: { ref: 'main' },
        merge_commit_sha: SHA,
        head: { ref: 'stage', repo: { full_name: 'REGIE-io/twenty' } },
      },
    ],
  });
  assert.match((await syncMainToStage(args)).skipped, /came from stage/);
  assert.equal(mutations(calls).length, 0);
});

test('accepts feature -> main merges and direct main pushes', async () => {
  const { args, calls } = fixture({
    sourcePrs: [
      {
        merged_at: '2026-10-14T12:00:00Z',
        base: { ref: 'main' },
        merge_commit_sha: SHA,
        head: {
          ref: 'fix/provisioning',
          repo: { full_name: 'REGIE-io/twenty' },
        },
      },
    ],
  });
  assert.equal((await syncMainToStage(args)).sha, SHA);
  assert.ok(calls.some((c) => c.name === 'createPr'));
});

test('an old stage association does not suppress a later main update', async () => {
  const { args } = fixture({
    sourcePrs: [
      {
        merged_at: '2026-10-14T12:00:00Z',
        base: { ref: 'main' },
        merge_commit_sha: STAGE,
        head: { ref: 'stage', repo: { full_name: 'REGIE-io/twenty' } },
      },
    ],
  });
  assert.equal((await syncMainToStage(args)).sha, SHA);
});

test('skips superseded deploys and commits already in stage', async () => {
  for (const options of [{ main: STAGE }, { ahead: 0 }]) {
    const { args, calls } = fixture(options);
    assert.ok((await syncMainToStage(args)).skipped);
    assert.equal(mutations(calls).length, 0);
  }
});

test('rejects a moved promotion branch without force-updating it', async () => {
  const { args, calls } = fixture({ branch: STAGE });
  await assert.rejects(syncMainToStage(args), /Promotion branch moved/);
  assert.equal(mutations(calls).length, 0);
});

test('reuses a pending promotion without duplicating or restarting CI', async () => {
  const { promotion } = fixture();
  promotion.auto_merge = { enabled_by: { login: 'automation' } };
  const { args, calls } = fixture({
    branch: SHA,
    openPrs: [promotion],
    ciRuns: [
      {
        head_sha: SHA,
        head_branch: PREFIX + SHA,
        path: '.github/workflows/ci-server.yaml',
        status: 'in_progress',
      },
    ],
  });
  await syncMainToStage(args);
  assert.equal(mutations(calls).length, 0);
});

test('does not re-request CI after all five result gates pass', async () => {
  const { promotion } = fixture();
  const { args, calls } = fixture({
    branch: SHA,
    openPrs: [promotion],
    ciRuns: ['front', 'ui', 'shared', 'server', 'twenty-apps'].map((area) => ({
      head_sha: SHA,
      head_branch: PREFIX + SHA,
      path: `.github/workflows/ci-${area}.yaml`,
      status: 'completed',
      conclusion: 'success',
    })),
  });
  await syncMainToStage(args);
  assert.deepEqual(
    mutations(calls).map((c) => c.name),
    ['autoMerge'],
  );
});

test('CI from another PR at the same SHA cannot suppress this promotion CI request', async () => {
  const { args, calls } = fixture({
    ciRuns: ['front', 'ui', 'shared', 'server', 'twenty-apps'].map((area) => ({
      head_sha: SHA,
      head_branch: 'another-pr',
      path: `.github/workflows/ci-${area}.yaml`,
      status: 'completed',
      conclusion: 'success',
    })),
  });
  await syncMainToStage(args);
  assert.ok(calls.some((c) => c.name === 'label'));
});

test('closes older automatic PRs while preserving manual stage PRs', async () => {
  const automatic = {
    number: 8,
    head: { ref: PREFIX + STAGE, repo: { full_name: 'REGIE-io/twenty' } },
  };
  const manual = {
    number: 9,
    head: { ref: 'fix/manual-stage', repo: { full_name: 'REGIE-io/twenty' } },
  };
  const { args, calls } = fixture({ openPrs: [automatic, manual] });
  await syncMainToStage(args);
  assert.deepEqual(
    calls.filter((c) => c.name === 'updatePr').map((c) => c.args.pull_number),
    [8],
  );
});

test('fails closed on API errors and an unexpected PR head', async () => {
  const failed = fixture();
  failed.args.github.rest.repos.listPullRequestsAssociatedWithCommit =
    async () => {
      throw new Error('GitHub unavailable');
    };
  await assert.rejects(syncMainToStage(failed.args), /GitHub unavailable/);
  assert.equal(mutations(failed.calls).length, 0);
  const moved = fixture({ pr: { head: { sha: STAGE } } });
  await assert.rejects(
    syncMainToStage(moved.args),
    /does not match deployment/,
  );
  assert.ok(
    !moved.calls.some((c) => c.name === 'autoMerge' || c.name === 'label'),
  );
});

test('merges an already-clean PR with an exact-head guard', async () => {
  const { args, calls } = fixture();
  args.github.graphql = async () => {
    throw new Error('Pull request is in clean status');
  };
  await syncMainToStage(args);
  const merge = calls.find((c) => c.name === 'mergePr');
  assert.equal(merge.args.sha, SHA);
  assert.equal(merge.args.merge_method, 'merge');
});

test('uses the repository token for PR writes and the PAT for CI and merge', async () => {
  const { args, calls } = fixture();
  args.pullRequestGithub = {
    rest: {
      pulls: {
        create: args.github.rest.pulls.create,
        update: args.github.rest.pulls.update,
      },
    },
  };
  args.github.rest.pulls.create = async () => {
    throw new Error('PAT cannot create PRs');
  };
  args.github.rest.pulls.update = async () => {
    throw new Error('PAT cannot update PRs');
  };
  await syncMainToStage(args);
  assert.ok(calls.some((c) => c.name === 'createPr'));
  assert.ok(calls.some((c) => c.name === 'label'));
  assert.ok(calls.some((c) => c.name === 'autoMerge'));
});

// Execute the real workflow guard with isolated git/GitHub responses. No network,
// live branch mutation, or application dependencies are needed.
for (const scenario of [
  { name: 'prior develop integration', develop: '0', expected: 0 },
  {
    name: 'a pinned main SHA deployed successfully',
    main: '0',
    deployed: '1',
    expected: 0,
  },
  { name: 'an undeployed main SHA', main: '0', deployed: '0', expected: 1 },
  { name: 'a SHA outside main', main: '1', deployed: '1', expected: 1 },
  {
    name: 'an arbitrary branch name',
    main: '0',
    deployed: '1',
    branch: 'fix/unverified',
    expected: 1,
  },
  {
    name: 'a fork using the promotion branch name',
    main: '0',
    deployed: '1',
    repository: 'fork/twenty',
    expected: 1,
  },
]) {
  test(`stage ancestry guard handles ${scenario.name}`, () => {
    const dir = mkdtempSync(join(process.cwd(), '.stage-ancestry-test-'));
    try {
      writeFileSync(
        join(dir, 'git'),
        `#!/bin/bash
if [[ "$1" == "merge-base" ]]; then
  if [[ "$4" == "refs/remotes/origin/develop" ]]; then exit "$DEVELOP_MATCH"; fi
  exit "$MAIN_MATCH"
fi
echo revision
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, 'gh'),
        `#!/bin/bash
printf '%s\\n' "$@" > "$GH_CALL_LOG"
echo "$DEPLOY_COUNT"
`,
        { mode: 0o755 },
      );
      const yaml = readFileSync(
        join(__dirname, '../workflows/stage-ancestry.yaml'),
        'utf8',
      );
      const script = yaml
        .split('        run: |\n')
        .at(-1)
        .split('\n')
        .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
        .join('\n');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          PR_HEAD_SHA: SHA,
          PR_HEAD_REF: scenario.branch ?? PREFIX + SHA,
          PR_HEAD_REPO: scenario.repository ?? 'REGIE-io/twenty',
          GITHUB_REPOSITORY: 'REGIE-io/twenty',
          DEVELOP_REF: 'refs/remotes/origin/develop',
          DEVELOP_MATCH: scenario.develop ?? '1',
          MAIN_MATCH: scenario.main ?? '1',
          DEPLOY_COUNT: scenario.deployed ?? '0',
          GH_CALL_LOG: join(dir, 'gh-call'),
        },
      });
      assert.equal(
        result.status,
        scenario.expected,
        result.stdout + result.stderr,
      );
      if (scenario.develop !== '0' && scenario.expected === 0) {
        const call = readFileSync(join(dir, 'gh-call'), 'utf8');
        assert.ok(call.includes(`head_sha=${SHA}`));
        assert.ok(call.includes('event=push'));
        assert.ok(call.includes('status=success'));
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
}
