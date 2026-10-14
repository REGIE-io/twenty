# Automatic main to stage sync

After a successful push-triggered production deployment from `main`, `sync-main-to-stage.yml` opens a stage PR pinned to that exact deployed commit, requests `run-ci`, and enables auto-merge under the existing required checks. Main updates merged from this repository's `stage` branch are excluded to prevent a promotion loop. Direct main pushes and other main PRs qualify. Failed deployments, manual deployment runs, superseded main revisions, and commits already contained in stage do not create a promotion.

The workflow uses the existing `DEPENDABOT_AUTOMERGE_PAT` secret so branch creation, PR labels, and merges start their normal downstream workflows. It never force-pushes or bypasses required checks. A rerun reuses the pinned branch and PR, and a newer promotion closes older automatic promotion PRs. The stage ancestry guard accepts either prior develop integration or a pinned main revision with a successful production deployment. After merge, the existing stage deployment runs the singleton upgrade, convergence gate, and service rollout. Inspect both the promotion PR and stage deploy result; auto-merge alone does not prove a completed rollout.

Run the orchestration tests without installing the application dependencies:

```bash
node --test .github/scripts/sync-main-to-stage.test.cjs
```

