# Automatic main to stage sync

After a successful push-triggered production deployment from `main`, `sync-main-to-stage.yml` opens a stage PR pinned to that exact deployed commit, requests `run-ci`, and enables auto-merge under the existing required checks. Main updates merged from this repository's `stage` branch are excluded to prevent a promotion loop. Direct main pushes and other main PRs qualify. Failed deployments, manual deployment runs, superseded main revisions, and commits already contained in stage do not create a promotion.

The repository `GITHUB_TOKEN` creates and closes promotion PRs with explicit pull-request write permission. The existing `DEPENDABOT_AUTOMERGE_PAT` creates branches, requests CI with labels, and enables merge so downstream workflows fire; that PAT cannot create PRs. Both the ancestry guard and orchestration tests also accept the PAT-triggered `run-ci` label, because repository-token PR creation does not emit another workflow event. The workflow never force-pushes or bypasses required checks. A rerun reuses the pinned branch and PR, and a newer promotion closes older automatic promotion PRs. The stage ancestry guard accepts either prior develop integration or a pinned main revision with a successful production deployment. After merge, the existing stage deployment runs the singleton upgrade, convergence gate, and service rollout. Inspect both the promotion PR and stage deploy result; auto-merge alone does not prove a completed rollout.

Run the orchestration tests without installing the application dependencies:

```bash
node --test .github/scripts/sync-main-to-stage.test.cjs
```

To recover a failed sync, rerun the sync workflow or dispatch it with `production_run_id` set to the successful production push run. The handler reloads that run from GitHub and applies the same exact-current-main, successful-deployment, and stage-source exclusion checks. This replay does not deploy production again or let a manual production deployment qualify.

