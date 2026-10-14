const PROMOTION_PREFIX = 'codex/promote-main-to-stage-';
const DEPLOY_WORKFLOW = 'deploy-prod.yml';

async function syncMainToStage({ github, context, core }) {
  const repo = context.repo;
  const fullName = `${repo.owner}/${repo.repo}`;
  const skip = (reason) => {
    core.info(reason);
    return { skipped: reason };
  };

  if (!context.payload.workflow_run?.id) return skip('No deployment run.');
  // Resolve the authoritative run instead of relying on optional webhook fields.
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...repo,
    run_id: context.payload.workflow_run.id,
  });

  if (
    !run ||
    run.conclusion !== 'success' ||
    run.event !== 'push' ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== fullName ||
    run.path !== `.github/workflows/${DEPLOY_WORKFLOW}`
  ) {
    return skip(
      'Only successful production deployments from a main push qualify.',
    );
  }
  const sha = run.head_sha;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid deployment SHA.');
  const { data: main } = await github.rest.git.getRef({
    ...repo,
    ref: 'heads/main',
  });
  if (main.object.sha !== sha)
    return skip('A newer main revision superseded this deployment.');

  const prs = await github.paginate(
    github.rest.repos.listPullRequestsAssociatedWithCommit,
    {
      ...repo,
      commit_sha: sha,
      per_page: 100,
    },
  );
  if (
    prs.some(
      (pr) =>
        pr.merged_at &&
        pr.base.ref === 'main' &&
        pr.merge_commit_sha === sha &&
        pr.head.ref === 'stage' &&
        pr.head.repo?.full_name === fullName,
    )
  ) {
    return skip('This main update came from stage; do not promote it back.');
  }

  const { data: stage } = await github.rest.git.getRef({
    ...repo,
    ref: 'heads/stage',
  });
  const { data: comparison } =
    await github.rest.repos.compareCommitsWithBasehead({
      ...repo,
      basehead: `${stage.object.sha}...${sha}`,
    });
  if (comparison.ahead_by === 0)
    return skip('Stage already contains this deployment.');

  // Never force-update a promotion branch: CI and auto-merge must refer to this exact SHA.
  const branch = `${PROMOTION_PREFIX}${sha}`;
  try {
    const { data: existing } = await github.rest.git.getRef({
      ...repo,
      ref: `heads/${branch}`,
    });
    if (existing.object.sha !== sha)
      throw new Error('Promotion branch moved from its deployment SHA.');
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({
      ...repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  const open = await github.paginate(github.rest.pulls.list, {
    ...repo,
    base: 'stage',
    state: 'open',
    per_page: 100,
  });
  let pr = open.find(
    (item) =>
      item.head.ref === branch && item.head.repo?.full_name === fullName,
  );
  if (!pr) {
    ({ data: pr } = await github.rest.pulls.create({
      ...repo,
      base: 'stage',
      head: branch,
      title: `Promote deployed main ${sha.slice(0, 10)} to stage`,
      body: [
        `Promote main revision \`${sha}\`, deployed successfully by [production run ${run.id}](${run.html_url}).`,
        '',
        'This branch is pinned to the deployed revision. Required stage CI and auto-merge remain enforced.',
        'After merge, the standard stage workflow runs the database upgrade and convergence check before rolling services.',
      ].join('\n'),
    }));
  }
  if (pr.head.sha !== sha)
    throw new Error('Promotion pull request head does not match deployment.');

  // Retire older automatic promotions before requesting CI for this one.
  for (const older of open) {
    if (
      older.number !== pr.number &&
      older.head.ref.startsWith(PROMOTION_PREFIX) &&
      older.head.repo?.full_name === fullName
    ) {
      await github.rest.pulls.update({
        ...repo,
        pull_number: older.number,
        state: 'closed',
      });
    }
  }
  // A PAT is required: GITHUB_TOKEN-created PRs/labels do not trigger downstream workflows.
  // Preserve an in-flight CI request when a completed deployment workflow is rerun.
  const runs = await github.paginate(
    github.rest.actions.listWorkflowRunsForRepo,
    {
      ...repo,
      head_sha: sha,
      branch,
      event: 'pull_request',
      per_page: 100,
    },
  );
  const paths = [
    'ci-front.yaml',
    'ci-ui.yaml',
    'ci-shared.yaml',
    'ci-server.yaml',
    'ci-twenty-apps.yaml',
  ];
  const ciRuns = runs.filter(
    (item) =>
      item.head_sha === sha &&
      item.head_branch === branch &&
      paths.some((path) => item.path === `.github/workflows/${path}`),
  );
  const inFlight = ciRuns.some((item) => item.status !== 'completed');
  const passed = paths.every(
    (path) =>
      ciRuns.find((item) => item.path === `.github/workflows/${path}`)
        ?.conclusion === 'success',
  );
  if (
    !inFlight &&
    !passed &&
    !pr.labels?.some((label) => label.name === 'run-ci')
  ) {
    await github.rest.issues.addLabels({
      ...repo,
      issue_number: pr.number,
      labels: ['run-ci'],
    });
  }
  if (!pr.auto_merge) {
    try {
      await github.graphql(
        `mutation($id: ID!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: MERGE}) {
        pullRequest { number }
      }
    }`,
        { id: pr.node_id },
      );
    } catch (error) {
      // CI may finish between the label and auto-merge request. GitHub rejects
      // enabling auto-merge on an already-clean PR; merge with an exact-head guard.
      if (!/pull request is in clean status/i.test(error.message)) throw error;
      const { data: merged } = await github.rest.pulls.merge({
        ...repo,
        pull_number: pr.number,
        sha,
        merge_method: 'merge',
      });
      if (!merged.merged)
        throw new Error('GitHub did not merge the ready promotion.');
    }
  }
  core.info(`Stage promotion: ${pr.html_url} (${sha}).`);
  return { number: pr.number, sha };
}

module.exports = { syncMainToStage };
